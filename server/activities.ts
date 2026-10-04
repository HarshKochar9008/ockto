// Every side effect lives here: storage, Postgres, model calls, notifications.
// Each activity is safe to retry: writes are keyed so a second run replaces, never duplicates.
import { createHash } from 'node:crypto';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { AiClassification, AiRequirements } from '../shared/schemas.ts';
import { chatJson, embed, ocrImage } from './ai.ts';
import {
  SYSTEM, assessmentPrompt, assessmentSchema, classificationPrompt, expectedClass, finalizeAssessment, finalizeClassification, finalizeRequirements,
  requirementsPrompt, type Assessment,
} from './analysis.ts';
import { audit, inTransaction, one, pool } from './db.ts';
import { chunkPages, extractPdfPages, needsOcr } from './documents.ts';
import { hybridSearch } from './retrieval.ts';
import { storage } from './storage.ts';

export interface DocInput { documentId: string; workspaceId: string; injectFailure?: string }

interface DocRow {
  id: string; workspace_id: string; role: 'requirements' | 'evidence'; filename: string; storage_key: string;
  mime_type: string; checksum: string; page_count: number | null; classification: string | null;
  extracted_text_reference: string | null; indexed_at: Date | null;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const signal = () => Context.current().cancellationSignal;

/** Heartbeats during slow model calls, so a dead worker is noticed in ~1 minute, not at the 15-minute timeout. */
async function heartbeating<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = Context.current();
  const timer = setInterval(() => ctx.heartbeat(), 10_000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

async function loadDoc(documentId: string): Promise<DocRow> {
  const doc = await one<DocRow>(pool, 'SELECT * FROM documents WHERE id = $1', [documentId]);
  if (!doc) throw ApplicationFailure.nonRetryable('the document no longer exists', 'DocumentNotFound');
  return doc;
}

export async function loadPages(ref: string | null): Promise<string[]> {
  if (!ref) throw ApplicationFailure.nonRetryable('no extracted text yet', 'InvalidState');
  return (JSON.parse((await storage.get(ref)).toString('utf8')) as { pages: string[] }).pages;
}

const today = () => new Date().toISOString().slice(0, 10);

export const activities = {
  // ------------------------------------------------------------ documents

  async startDocument({ documentId }: DocInput): Promise<void> {
    await pool.query(`UPDATE documents SET processing_status = 'processing', processing_error = NULL WHERE id = $1`, [documentId]);
  },

  /** Reuses earlier extraction: the stored text is keyed to the file, which never changes. */
  async extractText({ documentId }: DocInput): Promise<{ pages: number; reused: boolean }> {
    const doc = await loadDoc(documentId);
    if (doc.extracted_text_reference) return { pages: doc.page_count ?? 0, reused: true };
    const bytes = await storage.get(doc.storage_key);
    if (sha256(bytes) !== doc.checksum) throw ApplicationFailure.nonRetryable('the stored file does not match its checksum', 'InvalidDocument');

    let pages: string[];
    if (doc.mime_type === 'application/pdf') {
      pages = await extractPdfPages(bytes);
      if (needsOcr(pages)) {
        throw ApplicationFailure.nonRetryable(
          'No text layer found (scanned PDF?). Upload the pages as PNG or JPEG images to OCR them, or upload a text-based PDF.', 'OcrUnavailable');
      }
    } else if (doc.mime_type.startsWith('image/')) {
      pages = [await heartbeating(() => ocrImage(bytes, doc.mime_type, signal()))];
    } else {
      pages = bytes.toString('utf8').split('\f'); // form feed = page break in plain text
    }
    if (!pages.join('').trim()) throw ApplicationFailure.nonRetryable('the document contains no readable text', 'InvalidDocument');

    const key = `${doc.storage_key}.text.json`;
    await storage.put(key, JSON.stringify({ pages }), 'application/json');
    await pool.query('UPDATE documents SET extracted_text_reference = $2, page_count = $3 WHERE id = $1', [documentId, key, pages.length]);
    return { pages: pages.length, reused: false };
  },

  async classifyDocument({ documentId }: DocInput): Promise<string> {
    const doc = await loadDoc(documentId);
    const pages = await loadPages(doc.extracted_text_reference);
    const raw = await heartbeating(() =>
      chatJson(AiClassification, 'classify_document', SYSTEM, classificationPrompt(doc.filename, pages), signal()));
    const c = finalizeClassification(raw, pages.join('\n'));
    await pool.query(
      'UPDATE documents SET classification = $2, summary = $3, document_date = $4, expiry_date = $5 WHERE id = $1',
      [documentId, c.classification, c.summary, c.document_date, c.expiry_date],
    );
    return c.classification;
  },

  /** Replaces the document's chunks in one transaction: re-indexing never duplicates. */
  async indexDocument({ documentId }: DocInput): Promise<number> {
    const doc = await loadDoc(documentId);
    const chunks = chunkPages(await loadPages(doc.extracted_text_reference));
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += 16) {
      vectors.push(...await heartbeating(() => embed(chunks.slice(i, i + 16).map((c) => c.content), 'document', signal())));
    }
    await inTransaction(async (db) => {
      await db.query('DELETE FROM document_chunks WHERE document_id = $1', [documentId]);
      await db.query(
        `INSERT INTO document_chunks (document_id, workspace_id, chunk_index, page_number, content, embedding)
         SELECT $1, $2, i, p, c, e::vector FROM unnest($3::int[], $4::int[], $5::text[], $6::text[]) AS u(i, p, c, e)`,
        [documentId, doc.workspace_id, chunks.map((c) => c.index), chunks.map((c) => c.page),
          chunks.map((c) => c.content), vectors.map((v) => JSON.stringify(v))],
      );
      await db.query('UPDATE documents SET indexed_at = now() WHERE id = $1', [documentId]);
    });
    return chunks.length;
  },

  /** Drafts only: nothing is analysed until the user confirms the list. */
  async extractRequirements({ documentId }: DocInput): Promise<number> {
    const doc = await loadDoc(documentId);
    const pages = await loadPages(doc.extracted_text_reference);
    const raw = await heartbeating(() => chatJson(AiRequirements, 'extract_requirements', SYSTEM, requirementsPrompt(pages), signal()));
    const reqs = finalizeRequirements(raw, pages);
    await inTransaction(async (db) => {
      // A retry replaces this document's untouched drafts instead of adding to them.
      await db.query(`DELETE FROM requirements WHERE source_document_id = $1 AND origin = 'ai' AND NOT confirmed AND version = 1`, [documentId]);
      const { next } = (await one<{ next: number }>(db, 'SELECT coalesce(max(position) + 1, 0) AS next FROM requirements WHERE workspace_id = $1', [doc.workspace_id]))!;
      for (const [i, r] of reqs.entries()) {
        await db.query(
          `INSERT INTO requirements (workspace_id, title, description, required, due_date, source_document_id, source_page, source_excerpt, ambiguity, origin, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ai', $10)`,
          [doc.workspace_id, r.title, r.description, r.required, r.due_date, documentId, r.source_page, r.source_excerpt, r.ambiguity, next + i],
        );
      }
      await audit(db, { workspaceId: doc.workspace_id, actor: 'ai', type: 'requirements.extracted', entity: 'document', entityId: documentId, metadata: { count: reqs.length } });
    });
    return reqs.length;
  },

  async finishDocument({ documentId, error }: { documentId: string; error?: string }): Promise<void> {
    await pool.query('UPDATE documents SET processing_status = $2, processing_error = $3 WHERE id = $1',
      [documentId, error ? 'failed' : 'ready', error ?? null]);
  },

  /** What a retry can skip: earlier results that are still valid. */
  async inspectDocument({ documentId }: DocInput): Promise<{ role: DocRow['role']; hasText: boolean; classified: boolean; indexed: boolean; hasRequirements: boolean } | null> {
    const row = await one<{ role: DocRow['role']; has_text: boolean; classified: boolean; indexed: boolean; has_requirements: boolean }>(pool,
      `SELECT role, extracted_text_reference IS NOT NULL AS has_text, classification IS NOT NULL AS classified,
              EXISTS (SELECT 1 FROM document_chunks c WHERE c.document_id = d.id) AS indexed,
              EXISTS (SELECT 1 FROM requirements r WHERE r.source_document_id = d.id) AS has_requirements
       FROM documents d WHERE id = $1`, [documentId]);
    return row ? { role: row.role, hasText: row.has_text, classified: row.classified, indexed: row.indexed, hasRequirements: row.has_requirements } : null;
  },

  // ------------------------------------------------------------- analysis

  async requirementsToAssess({ workspaceId }: { workspaceId: string }): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM requirements WHERE workspace_id = $1 AND confirmed ORDER BY position, created_at', [workspaceId]);
    return rows.map((r) => r.id);
  },

  async assessRequirement({ workspaceId, requirementId, version }: { workspaceId: string; requirementId: string; version: number; injectFailure?: string }): Promise<string> {
    const req = await one<{ title: string; description: string; required: boolean; version: number; deadline: string | null }>(pool,
      `SELECT r.title, r.description, r.required, r.version, coalesce(r.due_date, w.deadline) AS deadline
       FROM requirements r JOIN workspaces w ON w.id = r.workspace_id WHERE r.id = $1 AND r.workspace_id = $2`,
      [requirementId, workspaceId]);
    if (!req) return 'deleted';

    const query = `${req.title}. ${req.description}`;
    const [vector] = await heartbeating(() => embed([query], 'query', signal()));
    const hits = await hybridSearch({ workspaceId, query, embedding: vector, limit: 6 });
    let result: Assessment;
    if (!hits.length) {
      result = { status: 'missing', explanation: 'No processed supporting documents in this workspace yet.', reviewReason: null, evidence: [] };
    } else {
      const passages = hits.map((h, i) => ({ ...h, label: `P${i + 1}` }));
      const raw = await heartbeating(() => chatJson(assessmentSchema(passages), 'assess_requirement', SYSTEM, assessmentPrompt(req, passages), signal()));
      result = finalizeAssessment(raw, passages, { today: today(), deadline: req.deadline, expected: expectedClass(req) });
    }
    await saveAssessment(workspaceId, requirementId, version, req.version, result);
    return result.status;
  },

  async markAssessmentFailed({ workspaceId, requirementId, version, error }: { workspaceId: string; requirementId: string; version: number; error: string }): Promise<void> {
    await saveAssessment(workspaceId, requirementId, version, null, {
      status: 'needs_review', explanation: 'PaperTrail could not assess this requirement automatically.', reviewReason: `Assessment failed: ${error}`, evidence: [],
    });
  },

  /** One open task per checklist item that needs action; closes tasks whose item no longer does. */
  async syncTasks({ workspaceId }: { workspaceId: string }): Promise<{ opened: number; closed: number }> {
    return inTransaction(async (db) => {
      const opened = await db.query(
        `INSERT INTO tasks (workspace_id, checklist_item_id, title, due_at, origin)
         SELECT r.workspace_id, ci.id,
                CASE ci.status WHEN 'missing' THEN 'Provide: ' WHEN 'expired' THEN 'Renew: ' ELSE 'Review: ' END || r.title,
                (coalesce(r.due_date, w.deadline) + time '23:59') AT TIME ZONE 'UTC', 'analysis'
         FROM checklist_items ci JOIN requirements r ON r.id = ci.requirement_id JOIN workspaces w ON w.id = r.workspace_id
         WHERE r.workspace_id = $1 AND r.confirmed AND ci.status IN ('missing', 'needs_review', 'expired')
           AND (r.required OR ci.status <> 'missing')
         ON CONFLICT (checklist_item_id) WHERE origin = 'analysis'
         DO UPDATE SET title = EXCLUDED.title, updated_at = now() WHERE tasks.status = 'open'`,
        [workspaceId],
      );
      const closed = await db.query(
        `UPDATE tasks t SET status = 'done', updated_at = now(), notes = coalesce(t.notes || E'\\n', '') || 'Closed automatically: the requirement is now covered.'
         FROM checklist_items ci
         WHERE t.checklist_item_id = ci.id AND t.workspace_id = $1 AND t.origin = 'analysis' AND t.status = 'open'
           AND ci.status IN ('satisfied', 'not_applicable')`,
        [workspaceId],
      );
      return { opened: opened.rowCount ?? 0, closed: closed.rowCount ?? 0 };
    });
  },

  // ------------------------------------------------------------ reminders

  /** Re-checks the task first and is keyed by the reminder row: a retry never sends twice. */
  async deliverReminder({ reminderId }: { reminderId: string; injectFailure?: string }): Promise<string> {
    const r = await one<{ delivery_status: string; idempotency_key: string; temporal_workflow_id: string; task_status: string; title: string; due_at: Date | null; workspace_id: string; workspace_name: string; task_id: string }>(pool,
      `SELECT r.delivery_status, r.idempotency_key, r.temporal_workflow_id, t.status AS task_status, t.title, t.due_at, t.id AS task_id,
              w.id AS workspace_id, w.name AS workspace_name
       FROM reminders r JOIN tasks t ON t.id = r.task_id JOIN workspaces w ON w.id = t.workspace_id WHERE r.id = $1`, [reminderId]);
    if (!r) return 'cancelled';
    // Rescheduling hands the row to a newer workflow; the old one must not deliver it.
    if (r.temporal_workflow_id !== Context.current().info.workflowExecution?.workflowId) return 'cancelled';
    if (r.delivery_status !== 'scheduled') return r.delivery_status;
    if (r.task_status !== 'open') {
      await pool.query(`UPDATE reminders SET delivery_status = 'suppressed', detail = $2 WHERE id = $1 AND delivery_status = 'scheduled'`,
        [reminderId, `task already ${r.task_status}`]);
      return 'suppressed';
    }
    const url = process.env.REMINDER_WEBHOOK_URL;
    if (url) {
      const due = r.due_at ? ` is due ${r.due_at.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ' is still open';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': r.idempotency_key },
        body: JSON.stringify({ text: `PaperTrail reminder: "${r.title}" (${r.workspace_name})${due}.` }),
        signal: signal(),
      });
      if (!res.ok) {
        const message = `reminder webhook answered HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw ApplicationFailure.nonRetryable(message, 'WebhookRejected');
        throw new Error(message);
      }
    }
    await pool.query(
      `UPDATE reminders SET delivery_status = 'sent', channel = $2, sent_at = now(), detail = $3 WHERE id = $1 AND delivery_status = 'scheduled'`,
      [reminderId, url ? 'webhook' : 'in_app', url ? 'delivered to the configured webhook' : 'shown in PaperTrail (no webhook configured)'],
    );
    await audit(pool, { workspaceId: r.workspace_id, actor: 'system', type: 'reminder.sent', entity: 'task', entityId: r.task_id, metadata: { channel: url ? 'webhook' : 'in_app' } });
    return 'sent';
  },

  async failReminder({ reminderId, error }: { reminderId: string; error: string }): Promise<void> {
    await pool.query(`UPDATE reminders SET delivery_status = 'failed', detail = $2 WHERE id = $1 AND delivery_status = 'scheduled'`, [reminderId, error]);
  },

  /** Only this workflow's rows: a reschedule may already have handed others to a newer workflow. */
  async closeReminders({ taskId, workflowId, status, detail }: { taskId: string; workflowId: string; status: 'suppressed' | 'cancelled'; detail: string }): Promise<number> {
    const res = await pool.query(
      `UPDATE reminders SET delivery_status = $3, detail = $4 WHERE task_id = $1 AND temporal_workflow_id = $2 AND delivery_status = 'scheduled'`,
      [taskId, workflowId, status, detail]);
    return res.rowCount ?? 0;
  },

  // ---------------------------------------------------------------- runs

  async finishRun({ workflowId, status, error }: { workflowId: string; status: 'completed' | 'failed' | 'cancelled'; error?: string }): Promise<void> {
    await pool.query(`UPDATE workflow_runs SET status = $2, completed_at = now(), last_error_summary = $3 WHERE workflow_id = $1`,
      [workflowId, status, error ?? null]);
  },
};

export type Activities = typeof activities;

/**
 * Writes one requirement's assessment for analysis `version`. Idempotent per
 * (item, version), and an older analysis never overwrites a newer one. A user's
 * verified status is kept; only the AI fields change.
 */
async function saveAssessment(workspaceId: string, requirementId: string, version: number, requirementVersion: number | null, a: Assessment): Promise<void> {
  await inTransaction(async (db) => {
    const item = await one<{ id: string; ai_status: string | null; assessment_version: number }>(db,
      `INSERT INTO checklist_items (requirement_id) VALUES ($1)
       ON CONFLICT (requirement_id) DO UPDATE SET requirement_id = EXCLUDED.requirement_id
       RETURNING id, ai_status, assessment_version`, [requirementId]);
    if (!item || item.assessment_version > version) return;
    await db.query('DELETE FROM evidence_matches WHERE checklist_item_id = $1 AND assessment_version = $2', [item.id, version]);
    for (const { passage: p, quote } of a.evidence) {
      await db.query(
        `INSERT INTO evidence_matches (checklist_item_id, document_id, chunk_id, page_number, excerpt, match_explanation, assessment_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [item.id, p.document_id, p.chunk_id, p.page_number, quote, `Passage ${p.label}`, version],
      );
    }
    await db.query(
      `UPDATE checklist_items SET ai_status = $2, status = CASE WHEN user_verified THEN status ELSE $2 END,
         explanation = $3, review_reason = $4, assessment_version = $5, requirement_version = coalesce($6, requirement_version), updated_at = now()
       WHERE id = $1`,
      [item.id, a.status, a.explanation, a.reviewReason, version, requirementVersion],
    );
    if (item.ai_status !== a.status) {
      await audit(db, { workspaceId, actor: 'ai', type: 'assessment.changed', entity: 'requirement', entityId: requirementId, metadata: { from: item.ai_status, to: a.status, version } });
    }
  });
}

/**
 * Demo hook: an activity whose input says `injectFailure: '<its name>'` fails on
 * attempt 1 only, so Temporal's retry (and Sentry's capture) can be shown live.
 */
export function withFailureInjection<T extends Record<string, (input: never) => Promise<unknown>>>(acts: T): T {
  return Object.fromEntries(Object.entries(acts).map(([name, fn]) => [name, async (input: { injectFailure?: string }) => {
    if (input?.injectFailure === name && Context.current().info.attempt === 1) {
      throw Object.assign(new Error(`Injected failure in ${name} (demo: attempt 1 fails, the retry succeeds)`), { name: 'InjectedFailure' });
    }
    return fn(input as never);
  }])) as unknown as T;
}
