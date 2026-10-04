// Business operations behind the HTTP routes (and the seed script). Every function
// that takes a userId checks ownership itself, so no route can forget to.
import { createHash, randomUUID } from 'node:crypto';
import { WorkflowNotFoundError, type Client, type WorkflowHandle } from '@temporalio/client';
import {
  AiAnswer, type AnswerDto, type AuditDto, type Counts, type DashboardDto, type DocumentDetail, type DocumentDto,
  type Me, type NextAction, type RequirementDto, type RunDto, type SearchHit, type StepDto, type SystemStatus, type TaskDto,
  type WorkspaceDetail, type WorkspaceSummary,
} from '../shared/schemas.ts';
import { aiConfig, chatJson, embed } from './ai.ts';
import { SYSTEM, answerPrompt, finalizeAnswer } from './analysis.ts';
import { hashPassword } from './auth.ts';
import { audit, inTransaction, one, pool } from './db.ts';
import { MAX_UPLOAD_BYTES, sniffMime } from './documents.ts';
import { hybridSearch } from './retrieval.ts';
import { storage, storageDriver } from './storage.ts';
import { TASK_QUEUE, sentryEventLink, sentryTraceLink, temporalLink, temporalUiUrl } from './temporal.ts';
import {
  analyzeWorkspaceWorkflow, cancelReminders, processDocumentWorkflow, reminderWorkflow, retryFailedProcessingWorkflow, taskClosed,
} from './workflows.ts';

export type Temporal = Pick<Client, 'workflow'>;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const notFound = (what: string) => new HttpError(404, `${what} not found`);
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pgCode = (err: unknown) => (err as { code?: string }).code;

export const demoFailureInjection = process.env.DEMO_FAILURE_INJECTION === 'true';

export function systemStatus(): SystemStatus {
  const strip = (u: string) => { const url = new URL(u); url.username = ''; url.password = ''; return url.toString(); };
  return {
    ai: { base_url: strip(aiConfig.baseUrl), chat_model: aiConfig.chatModel, embedding_model: aiConfig.embeddingModel, ocr_model: aiConfig.ocrModel },
    storage: storageDriver,
    sentry: Boolean(process.env.SENTRY_DSN),
    reminder_webhook: Boolean(process.env.REMINDER_WEBHOOK_URL),
    temporal_ui_url: temporalUiUrl,
    demo_failure_injection: demoFailureInjection,
  };
}

// ------------------------------------------------------------------ ownership

interface WorkspaceRow { id: string; user_id: string; name: string; deadline: string | null }
interface DocumentRow extends DocumentDto { storage_key: string; extracted_text_reference: string | null }

async function ownWorkspace(userId: string, id: string): Promise<WorkspaceRow> {
  return (await one<WorkspaceRow>(pool, 'SELECT id, user_id, name, deadline FROM workspaces WHERE id = $1 AND user_id = $2', [id, userId]))
    ?? Promise.reject(notFound('Workspace'));
}

const DOC_COLS = ['id', 'workspace_id', 'role', 'filename', 'mime_type', 'size_bytes', 'classification', 'summary', 'document_date',
  'expiry_date', 'page_count', 'processing_status', 'processing_error', 'created_at'];
const docCols = (alias = 'd') => DOC_COLS.map((c) => `${alias}.${c}`).join(', ');

async function ownDocument(userId: string, id: string): Promise<DocumentRow> {
  return (await one<DocumentRow>(pool,
    `SELECT ${docCols()}, d.storage_key, d.extracted_text_reference FROM documents d JOIN workspaces w ON w.id = d.workspace_id
     WHERE d.id = $1 AND w.user_id = $2`, [id, userId])) ?? Promise.reject(notFound('Document'));
}

async function ownRequirement(userId: string, id: string) {
  return (await one<{ id: string; workspace_id: string; title: string }>(pool,
    `SELECT r.id, r.workspace_id, r.title FROM requirements r JOIN workspaces w ON w.id = r.workspace_id WHERE r.id = $1 AND w.user_id = $2`,
    [id, userId])) ?? Promise.reject(notFound('Requirement'));
}

async function ownTask(userId: string, id: string) {
  return (await one<{ id: string; workspace_id: string; status: TaskDto['status'] }>(pool,
    `SELECT t.id, t.workspace_id, t.status FROM tasks t JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = $1 AND w.user_id = $2`,
    [id, userId])) ?? Promise.reject(notFound('Task'));
}

/** `SET a = $2, b = $3` from a validated patch; column names come from the allow-list, never from input. */
function setClause(patch: Record<string, unknown>, allowed: string[], first = 2) {
  const keys = allowed.filter((k) => patch[k] !== undefined);
  return { sql: keys.map((k, i) => `${k} = $${i + first}`).join(', '), values: keys.map((k) => patch[k] ?? null) };
}

// ----------------------------------------------------------------- workflows

/** Records the run, then starts it. The row exists first so the worker can journal into it. */
async function startRun(workspaceId: string, subjectId: string | null, type: string, workflowId: string, start: () => Promise<unknown>): Promise<string> {
  await pool.query('INSERT INTO workflow_runs (workspace_id, workflow_id, workflow_type, subject_id) VALUES ($1, $2, $3, $4)',
    [workspaceId, workflowId, type, subjectId]);
  try {
    await start();
  } catch (err) {
    console.error(`could not start ${workflowId}: ${(err as Error).message}`);
    await pool.query(`UPDATE workflow_runs SET status = 'failed', completed_at = now(), last_error_summary = $2 WHERE workflow_id = $1`,
      [workflowId, 'Could not start: the workflow service is unavailable.']);
    throw new HttpError(503, 'The workflow service is unavailable. Please try again shortly.');
  }
  return workflowId;
}

/** Signals are a fast path only: the database already says what happened, and workflows re-check it. */
async function signalAll(t: Temporal, workflowIds: string[], send: (h: WorkflowHandle) => Promise<unknown>): Promise<void> {
  await Promise.all(workflowIds.map((id) => send(t.workflow.getHandle(id)).catch((err) => {
    if (!(err instanceof WorkflowNotFoundError)) console.warn(`signal to ${id} failed: ${(err as Error).message}`);
  })));
}

async function cancelRunsFor(t: Temporal, subjectId: string): Promise<void> {
  const { rows } = await pool.query<{ workflow_id: string }>(`SELECT workflow_id FROM workflow_runs WHERE subject_id = $1 AND status = 'running'`, [subjectId]);
  await signalAll(t, rows.map((r) => r.workflow_id), (h) => h.cancel());
}

// --------------------------------------------------------------------- users

export async function signup(input: { email: string; name?: string; password: string }): Promise<Me> {
  const user = await one<Me>(pool,
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id, email, name`,
    [input.email.toLowerCase(), input.name ?? input.email.split('@')[0], await hashPassword(input.password)]);
  if (!user) throw new HttpError(409, 'An account with this email already exists.');
  return user;
}

// ---------------------------------------------------------------- workspaces

const SUMMARY_SQL = `
  SELECT w.id, w.name, w.process_type, w.institution, w.deadline, w.status, w.created_at, w.updated_at,
         w.notes, w.requirements_confirmed_at, w.assessment_version, r.*, d.*, t.*
  FROM workspaces w
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS requirements,
           count(*) FILTER (WHERE coalesce(ci.status, 'pending') = 'pending')::int AS pending,
           count(*) FILTER (WHERE ci.status = 'satisfied')::int AS satisfied,
           count(*) FILTER (WHERE ci.status = 'satisfied' AND ci.user_verified)::int AS satisfied_verified,
           count(*) FILTER (WHERE ci.status = 'needs_review')::int AS needs_review,
           count(*) FILTER (WHERE ci.status = 'missing')::int AS missing,
           count(*) FILTER (WHERE ci.status = 'expired')::int AS expired,
           count(*) FILTER (WHERE ci.status = 'not_applicable')::int AS not_applicable,
           count(*) FILTER (WHERE ci.user_verified)::int AS verified
    FROM requirements r LEFT JOIN checklist_items ci ON ci.requirement_id = r.id WHERE r.workspace_id = w.id) r ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS documents,
           count(*) FILTER (WHERE processing_status IN ('queued', 'processing'))::int AS processing,
           count(*) FILTER (WHERE processing_status = 'failed')::int AS failed_documents
    FROM documents WHERE workspace_id = w.id) d ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS open_tasks, min(due_at) AS next_due_at FROM tasks WHERE workspace_id = w.id AND status = 'open') t ON true
  WHERE w.user_id = $1 AND ($2::uuid IS NULL OR w.id = $2)
  ORDER BY w.updated_at DESC`;

const COUNT_KEYS: (keyof Counts)[] = ['requirements', 'pending', 'satisfied', 'satisfied_verified', 'needs_review', 'missing', 'expired', 'not_applicable',
  'verified', 'documents', 'processing', 'failed_documents', 'open_tasks'];

type SummaryRow = WorkspaceSummary & Counts & { notes: string | null; requirements_confirmed_at: string | null; assessment_version: number };

const toSummary = (r: SummaryRow): WorkspaceSummary => ({
  id: r.id, name: r.name, process_type: r.process_type, institution: r.institution, deadline: r.deadline, status: r.status,
  created_at: r.created_at, updated_at: r.updated_at, next_due_at: r.next_due_at,
  counts: Object.fromEntries(COUNT_KEYS.map((k) => [k, r[k]])) as unknown as Counts,
});

export async function listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
  return (await pool.query<SummaryRow>(SUMMARY_SQL, [userId, null])).rows.map(toSummary);
}

export async function createWorkspace(userId: string, input: { name: string; process_type: string; institution?: string | null; deadline?: string | null; notes?: string | null }): Promise<WorkspaceDetail> {
  const { id } = (await one<{ id: string }>(pool,
    `INSERT INTO workspaces (user_id, name, process_type, institution, deadline, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, input.name, input.process_type, input.institution ?? null, input.deadline ?? null, input.notes ?? null]))!;
  await audit(pool, { workspaceId: id, actor: 'user', actorId: userId, type: 'workspace.created', entity: 'workspace', entityId: id });
  return getWorkspace(userId, id);
}

export async function updateWorkspace(userId: string, id: string, patch: Record<string, unknown>): Promise<WorkspaceDetail> {
  await ownWorkspace(userId, id);
  const set = setClause(patch, ['name', 'process_type', 'institution', 'deadline', 'notes', 'status']);
  if (set.values.length) {
    await pool.query(`UPDATE workspaces SET ${set.sql}, updated_at = now() WHERE id = $1`, [id, ...set.values]);
    await audit(pool, { workspaceId: id, actor: 'user', actorId: userId, type: 'workspace.updated', entity: 'workspace', entityId: id, metadata: { fields: Object.keys(patch) } });
  }
  return getWorkspace(userId, id);
}

/** Deletes the workspace, its rows (cascade), and its files in object storage. */
export async function deleteWorkspace(t: Temporal, userId: string, id: string): Promise<void> {
  await ownWorkspace(userId, id);
  const { rows: runs } = await pool.query<{ workflow_id: string }>(`SELECT workflow_id FROM workflow_runs WHERE workspace_id = $1 AND status = 'running'`, [id]);
  const { rows: files } = await pool.query<{ storage_key: string; extracted_text_reference: string | null }>(
    'SELECT storage_key, extracted_text_reference FROM documents WHERE workspace_id = $1', [id]);
  await pool.query('DELETE FROM workspaces WHERE id = $1', [id]);
  await signalAll(t, runs.map((r) => r.workflow_id), (h) => h.cancel());
  await deleteFiles(files.flatMap((f) => [f.storage_key, f.extracted_text_reference]));
}

async function deleteFiles(keys: (string | null)[]): Promise<void> {
  // ponytail: a failed delete leaves an orphaned object and is only logged; add a sweep job if this ever shows up.
  await Promise.all(keys.filter((k): k is string => Boolean(k)).map((k) =>
    storage.delete(k).catch((err: Error) => console.error(`ORPHANED FILE ${k}: ${err.message}`))));
}

export async function getWorkspace(userId: string, id: string): Promise<WorkspaceDetail> {
  const row = await one<SummaryRow>(pool, SUMMARY_SQL, [userId, id]);
  if (!row) throw notFound('Workspace');
  const [requirements, failedDocs, reading, analysis, stale] = await Promise.all([
    listRequirements(userId, id),
    pool.query<{ id: string; filename: string; processing_error: string | null }>(
      `SELECT id, filename, processing_error FROM documents WHERE workspace_id = $1 AND processing_status = 'failed'`, [id]),
    pool.query<Reading>(
      `SELECT id, role, filename FROM documents WHERE workspace_id = $1 AND processing_status IN ('queued', 'processing') ORDER BY created_at`, [id]),
    latestRun(id, 'analyzeWorkspace'),
    one<{ stale: boolean; evidence_ready: number }>(pool,
      `SELECT EXISTS (SELECT 1 FROM requirements r LEFT JOIN checklist_items ci ON ci.requirement_id = r.id
                      WHERE r.workspace_id = $1 AND r.confirmed
                        AND (ci.id IS NULL OR ci.assessment_version = 0 OR ci.requirement_version IS DISTINCT FROM r.version))
           OR EXISTS (SELECT 1 FROM documents d WHERE d.workspace_id = $1 AND d.role = 'evidence' AND d.indexed_at > coalesce(
                        (SELECT max(started_at) FROM workflow_runs WHERE workspace_id = $1 AND workflow_type = 'analyzeWorkspace'), '-infinity'))
           AS stale,
         (SELECT count(*)::int FROM documents WHERE workspace_id = $1 AND role = 'evidence' AND processing_status = 'ready') AS evidence_ready`, [id]),
  ]);
  const summary = toSummary(row);
  const staleAnalysis = Boolean(stale?.stale) && analysis?.status !== 'running';
  return {
    ...summary, notes: row.notes, requirements_confirmed_at: row.requirements_confirmed_at, assessment_version: row.assessment_version,
    analysis, stale_analysis: staleAnalysis,
    next_actions: nextActions(requirements, failedDocs.rows, stale?.evidence_ready ?? 0, staleAnalysis, analysis, reading.rows),
  };
}

type Reading = { id: string; role: 'requirements' | 'evidence'; filename: string };

/**
 * What to do next, most urgent first. Derived from the checklist; never stored.
 * `reading` is what is still being processed: while the requirements are read, the user is pointed at
 * uploading their documents (which process in parallel) instead of being asked to add requirements again.
 */
export function nextActions(
  reqs: RequirementDto[], failedDocs: { id: string; filename: string; processing_error: string | null }[],
  evidenceReady: number, stale: boolean, analysis: RunDto | null, reading: Reading[] = [],
): NextAction[] {
  const actions: NextAction[] = failedDocs.map((d) => ({
    kind: 'fix_document', title: `Fix ${d.filename}`, detail: d.processing_error ?? 'Processing failed.', document_id: d.id,
  }));
  const confirmed = reqs.filter((r) => r.confirmed);
  const sources = reading.filter((d) => d.role === 'requirements');
  const evidence = reading.filter((d) => d.role === 'evidence');
  const evidenceReading = evidence.length;
  if (!reqs.length && sources.length) {
    actions.push({ kind: 'processing', title: `Reading ${sources.map((d) => d.filename).join(', ')}`,
      detail: 'Draft requirements appear on the Requirements tab when it finishes.', document_id: sources[0].id });
  } else if (!reqs.length) {
    actions.push({ kind: 'add_requirements', title: 'Add the requirements', detail: 'Upload the requirements PDF or paste the requirements text.' });
  } else if (confirmed.length < reqs.length) {
    const drafts = reqs.length - confirmed.length;
    actions.push({ kind: 'confirm_requirements', title: 'Review and confirm the extracted requirements',
      detail: `${drafts} draft${drafts === 1 ? '' : 's'} to check. Nothing is analysed until you confirm them.` });
  }
  if (!evidenceReady && evidenceReading) {
    actions.push({ kind: 'processing', title: `Reading ${evidenceReading} of your document${evidenceReading === 1 ? '' : 's'}`,
      detail: 'They are read in the background. You can leave this page.', document_id: evidence[0].id });
  } else if (!evidenceReady && (reqs.length || sources.length)) {
    actions.push({ kind: 'upload', title: confirmed.length ? 'Upload your supporting documents' : 'While you wait, upload your documents',
      detail: 'Transcripts, certificates, passport, CV and letters. They are read in the background.' });
  } else if (confirmed.length && evidenceReady && stale && analysis?.status !== 'running') {
    actions.push({ kind: 'analyze', title: analysis ? 'Run the analysis again' : 'Run the analysis',
      detail: analysis ? 'Documents or requirements changed since the last analysis.' : 'Your requirements are confirmed and your documents are ready.' });
  }
  const rank = { expired: 0, missing: 1, needs_review: 2 } as Record<string, number>;
  for (const r of [...confirmed].sort((a, b) => (rank[a.checklist?.status ?? ''] ?? 9) - (rank[b.checklist?.status ?? ''] ?? 9))) {
    const c = r.checklist;
    if (!c) continue;
    if (c.status === 'expired') actions.push({ kind: 'renew', title: `Renew: ${r.title}`, detail: c.review_reason ?? 'The supporting document has expired.', requirement_id: r.id });
    else if (c.status === 'missing' && r.required) actions.push({ kind: 'upload', title: `Provide: ${r.title}`, detail: 'No matching evidence was found in your documents.', requirement_id: r.id });
    else if (c.status === 'needs_review') actions.push({ kind: 'review', title: `Review: ${r.title}`, detail: c.review_reason ?? c.explanation ?? 'Needs a human check.', requirement_id: r.id });
  }
  return actions.slice(0, 12);
}

// ----------------------------------------------------------------- documents

export async function uploadDocument(
  t: Temporal, userId: string, workspaceId: string,
  file: { bytes: Buffer; filename: string; declaredType?: string; role: 'requirements' | 'evidence'; injectFailure?: string },
): Promise<{ document: DocumentDto; duplicate: boolean }> {
  await ownWorkspace(userId, workspaceId);
  if (!file.bytes.length) throw new HttpError(400, 'The file is empty.');
  if (file.bytes.length > MAX_UPLOAD_BYTES) throw new HttpError(413, `Files are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  const mime = sniffMime(file.bytes);
  if (!mime) throw new HttpError(415, 'Unsupported file. Upload a PDF, PNG, JPEG or plain-text file.');
  const declared = file.declaredType?.split(';')[0]?.trim();
  if (declared && declared !== 'application/octet-stream' && declared !== mime) {
    throw new HttpError(415, `The file's content (${mime}) does not match its declared type (${declared}).`);
  }
  const checksum = sha256(file.bytes);
  const findExisting = () => one<DocumentDto>(pool, `SELECT ${docCols()} FROM documents d WHERE d.workspace_id = $1 AND d.checksum = $2`, [workspaceId, checksum]);
  const existing = await findExisting();
  if (existing) return { document: existing, duplicate: true };

  const id = randomUUID();
  const key = `workspaces/${workspaceId}/documents/${id}`;
  await storage.put(key, file.bytes, mime);
  let document: DocumentDto;
  try {
    document = (await one<DocumentDto>(pool,
      `INSERT INTO documents (id, workspace_id, role, filename, storage_key, mime_type, size_bytes, checksum, classification)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${DOC_COLS.join(', ')}`,
      [id, workspaceId, file.role, file.filename, key, mime, file.bytes.length, checksum, file.role === 'requirements' ? 'requirements' : null]))!;
  } catch (err) {
    await storage.delete(key);
    const raced = pgCode(err) === '23505' ? await findExisting() : undefined; // same file uploaded twice at once
    if (raced) return { document: raced, duplicate: true };
    throw err;
  }
  await audit(pool, { workspaceId, actor: 'user', actorId: userId, type: 'document.uploaded', entity: 'document', entityId: id,
    metadata: { filename: file.filename, role: file.role, size_bytes: file.bytes.length } });
  const workflowId = `process-document:${id}`;
  try {
    await startRun(workspaceId, id, 'processDocument', workflowId, () => t.workflow.start(processDocumentWorkflow, {
      workflowId, taskQueue: TASK_QUEUE, args: [{ documentId: id, workspaceId, role: file.role, injectFailure: file.injectFailure }],
    }));
  } catch (err) {
    await pool.query(`UPDATE documents SET processing_status = 'failed', processing_error = $2 WHERE id = $1`, [id, 'Processing could not start. Use Retry.']);
    throw err;
  }
  return { document, duplicate: false };
}

export async function listDocuments(userId: string, workspaceId: string): Promise<DocumentDto[]> {
  await ownWorkspace(userId, workspaceId);
  return (await pool.query<DocumentDto>(`SELECT ${docCols()} FROM documents d WHERE d.workspace_id = $1 ORDER BY d.created_at DESC`, [workspaceId])).rows;
}

export async function getDocument(userId: string, id: string): Promise<DocumentDetail> {
  const { storage_key: _, extracted_text_reference: ref, ...doc } = await ownDocument(userId, id);
  const pages = ref ? (JSON.parse((await storage.get(ref)).toString('utf8')) as { pages: string[] }).pages : null;
  return { ...doc, pages, runs: await runs(doc.workspace_id, { subjectId: id }) };
}

/** Either a short-lived storage URL (S3) or the bytes to stream (local storage). */
export async function documentFile(userId: string, id: string) {
  const doc = await ownDocument(userId, id);
  const url = await storage.signedUrl(doc.storage_key, doc.filename, doc.mime_type);
  return { url, bytes: url ? undefined : await storage.get(doc.storage_key), mime: doc.mime_type, filename: doc.filename };
}

export async function retryDocument(t: Temporal, userId: string, id: string, injectFailure?: string): Promise<{ workflow_id: string }> {
  const doc = await ownDocument(userId, id);
  const claimed = await one(pool, `UPDATE documents SET processing_status = 'queued', processing_error = NULL WHERE id = $1 AND processing_status = 'failed' RETURNING id`, [id]);
  if (!claimed) throw new HttpError(409, 'Only failed documents can be retried.');
  const { n } = (await one<{ n: number }>(pool, 'SELECT count(*)::int + 1 AS n FROM workflow_runs WHERE subject_id = $1', [id]))!;
  const workflowId = `retry-document:${id}:${n}`;
  try {
    await startRun(doc.workspace_id, id, 'retryFailedProcessing', workflowId, () => t.workflow.start(retryFailedProcessingWorkflow, {
      workflowId, taskQueue: TASK_QUEUE, args: [{ documentId: id, workspaceId: doc.workspace_id, injectFailure }],
    }));
  } catch (err) {
    await pool.query(`UPDATE documents SET processing_status = 'failed', processing_error = $2 WHERE id = $1`, [id, 'Retry could not start.']);
    throw err;
  }
  await audit(pool, { workspaceId: doc.workspace_id, actor: 'user', actorId: userId, type: 'document.retry', entity: 'document', entityId: id, metadata: { workflow_id: workflowId } });
  return { workflow_id: workflowId };
}

/**
 * Removes the file, its extracted text, chunks and embeddings (cascade), so it can
 * never be retrieved again. Checklist items it supported go back to review.
 */
export async function deleteDocument(t: Temporal, userId: string, id: string): Promise<void> {
  const doc = await ownDocument(userId, id);
  await inTransaction(async (db) => {
    await db.query(
      `UPDATE checklist_items SET status = 'needs_review', ai_status = 'needs_review', user_verified = false, review_reason = $2, updated_at = now()
       WHERE id IN (SELECT em.checklist_item_id FROM evidence_matches em JOIN checklist_items ci ON ci.id = em.checklist_item_id
                    WHERE em.document_id = $1 AND em.assessment_version = ci.assessment_version)`,
      [id, `Supporting document "${doc.filename}" was deleted. Upload a replacement or re-run the analysis.`]);
    await db.query('DELETE FROM documents WHERE id = $1', [id]);
    await audit(db, { workspaceId: doc.workspace_id, actor: 'user', actorId: userId, type: 'document.deleted', entity: 'document', entityId: id, metadata: { filename: doc.filename } });
  });
  await cancelRunsFor(t, id);
  await deleteFiles([doc.storage_key, doc.extracted_text_reference]);
}

// -------------------------------------------------------------- requirements

const REQUIREMENTS_SQL = (filter: string) => `
  SELECT r.id, r.title, r.description, r.required, r.due_date, r.source_document_id, r.source_page, r.source_excerpt,
         r.ambiguity, r.origin, r.confirmed, r.version,
         CASE WHEN ci.id IS NULL THEN NULL ELSE json_build_object(
           'id', ci.id, 'status', ci.status, 'ai_status', ci.ai_status, 'explanation', ci.explanation,
           'review_reason', ci.review_reason, 'user_verified', ci.user_verified, 'user_note', ci.user_note,
           'assessment_version', ci.assessment_version,
           'stale', ci.assessment_version = 0 OR ci.requirement_version IS DISTINCT FROM r.version,
           'updated_at', ci.updated_at,
           'evidence', coalesce((
             SELECT json_agg(json_build_object('id', em.id, 'document_id', em.document_id, 'filename', d.filename,
                      'page_number', em.page_number, 'excerpt', em.excerpt, 'match_explanation', em.match_explanation,
                      'chunk_id', em.chunk_id, 'assessment_version', em.assessment_version) ORDER BY em.created_at)
             FROM evidence_matches em JOIN documents d ON d.id = em.document_id
             WHERE em.checklist_item_id = ci.id AND em.assessment_version = ci.assessment_version), '[]'::json)
         ) END AS checklist
  FROM requirements r LEFT JOIN checklist_items ci ON ci.requirement_id = r.id
  WHERE ${filter}
  ORDER BY r.position, r.created_at`;

export async function listRequirements(userId: string, workspaceId: string): Promise<RequirementDto[]> {
  await ownWorkspace(userId, workspaceId);
  return (await pool.query<RequirementDto>(REQUIREMENTS_SQL('r.workspace_id = $1'), [workspaceId])).rows;
}

export async function getRequirement(userId: string, id: string): Promise<RequirementDto> {
  await ownRequirement(userId, id);
  return (await one<RequirementDto>(pool, REQUIREMENTS_SQL('r.id = $1'), [id]))!;
}

/** Typed in by the user: their own words, so confirmed straight away. */
export async function addRequirement(userId: string, workspaceId: string, input: { title: string; description: string; required: boolean; due_date?: string | null }): Promise<RequirementDto> {
  await ownWorkspace(userId, workspaceId);
  const { id } = (await one<{ id: string }>(pool,
    `INSERT INTO requirements (workspace_id, title, description, required, due_date, origin, confirmed, position)
     VALUES ($1, $2, $3, $4, $5, 'user', true, (SELECT coalesce(max(position) + 1, 0) FROM requirements WHERE workspace_id = $1)) RETURNING id`,
    [workspaceId, input.title, input.description, input.required, input.due_date ?? null]))!;
  await pool.query(`INSERT INTO checklist_items (requirement_id) VALUES ($1)`, [id]);
  await audit(pool, { workspaceId, actor: 'user', actorId: userId, type: 'requirement.added', entity: 'requirement', entityId: id });
  return getRequirement(userId, id);
}

export async function extractRequirementsFromText(t: Temporal, userId: string, workspaceId: string, text: string, injectFailure?: string) {
  return uploadDocument(t, userId, workspaceId, { bytes: Buffer.from(text, 'utf8'), filename: 'pasted-requirements.txt', declaredType: 'text/plain', role: 'requirements', injectFailure });
}

/** An edit makes earlier verification meaningless: the user verified a different requirement. */
export async function updateRequirement(userId: string, id: string, patch: Record<string, unknown>): Promise<RequirementDto> {
  const req = await ownRequirement(userId, id);
  const set = setClause(patch, ['title', 'description', 'required', 'due_date']);
  if (set.values.length) {
    await inTransaction(async (db) => {
      await db.query(`UPDATE requirements SET ${set.sql}, version = version + 1, updated_at = now() WHERE id = $1`, [id, ...set.values]);
      await db.query(`UPDATE checklist_items SET user_verified = false, status = coalesce(ai_status, 'pending'), updated_at = now() WHERE requirement_id = $1 AND user_verified`, [id]);
      await audit(db, { workspaceId: req.workspace_id, actor: 'user', actorId: userId, type: 'requirement.edited', entity: 'requirement', entityId: id, metadata: { fields: Object.keys(patch) } });
    });
  }
  return getRequirement(userId, id);
}

export async function deleteRequirement(userId: string, id: string): Promise<void> {
  const req = await ownRequirement(userId, id);
  await pool.query('DELETE FROM requirements WHERE id = $1', [id]);
  await audit(pool, { workspaceId: req.workspace_id, actor: 'user', actorId: userId, type: 'requirement.deleted', entity: 'requirement', entityId: id, metadata: { title: req.title } });
}

export async function confirmRequirements(userId: string, workspaceId: string): Promise<RequirementDto[]> {
  await ownWorkspace(userId, workspaceId);
  await inTransaction(async (db) => {
    const { rowCount } = await db.query('UPDATE requirements SET confirmed = true, updated_at = now() WHERE workspace_id = $1 AND NOT confirmed', [workspaceId]);
    await db.query(`INSERT INTO checklist_items (requirement_id) SELECT id FROM requirements WHERE workspace_id = $1 ON CONFLICT DO NOTHING`, [workspaceId]);
    await db.query('UPDATE workspaces SET requirements_confirmed_at = now() WHERE id = $1', [workspaceId]);
    await audit(db, { workspaceId, actor: 'user', actorId: userId, type: 'requirements.confirmed', entity: 'workspace', entityId: workspaceId, metadata: { count: rowCount } });
  });
  return listRequirements(userId, workspaceId);
}

// ------------------------------------------------------------------ analysis

export async function analyze(t: Temporal, userId: string, workspaceId: string, injectFailure?: string): Promise<{ workflow_id: string; version: number }> {
  await ownWorkspace(userId, workspaceId);
  const state = (await one<{ confirmed: number; running: boolean }>(pool,
    `SELECT (SELECT count(*)::int FROM requirements WHERE workspace_id = $1 AND confirmed) AS confirmed,
            EXISTS (SELECT 1 FROM workflow_runs WHERE workspace_id = $1 AND workflow_type = 'analyzeWorkspace' AND status = 'running') AS running`,
    [workspaceId]))!;
  if (!state.confirmed) throw new HttpError(409, 'Confirm at least one requirement before running the analysis.');
  if (state.running) throw new HttpError(409, 'An analysis is already running for this workspace.');
  const { version } = (await one<{ version: number }>(pool,
    'UPDATE workspaces SET assessment_version = assessment_version + 1 WHERE id = $1 RETURNING assessment_version AS version', [workspaceId]))!;
  const workflowId = `analyze:${workspaceId}:v${version}`;
  await startRun(workspaceId, workspaceId, 'analyzeWorkspace', workflowId, () => t.workflow.start(analyzeWorkspaceWorkflow, {
    workflowId, taskQueue: TASK_QUEUE, args: [{ workspaceId, version, injectFailure }],
  }));
  await audit(pool, { workspaceId, actor: 'user', actorId: userId, type: 'analysis.started', entity: 'workspace', entityId: workspaceId, metadata: { version } });
  return { workflow_id: workflowId, version };
}

export async function getAnalysis(userId: string, workspaceId: string) {
  const ws = await getWorkspace(userId, workspaceId);
  return { version: ws.assessment_version, run: ws.analysis, stale: ws.stale_analysis, counts: ws.counts };
}

/** A human decision always wins over the AI's and is audited. Un-verifying returns to the AI status. */
export async function reviewChecklistItem(userId: string, id: string, patch: { status?: string; user_verified?: boolean; user_note?: string | null }): Promise<RequirementDto> {
  const item = await one<{ requirement_id: string; workspace_id: string; status: string; ai_status: string | null; user_verified: boolean }>(pool,
    `SELECT ci.requirement_id, r.workspace_id, ci.status, ci.ai_status, ci.user_verified
     FROM checklist_items ci JOIN requirements r ON r.id = ci.requirement_id JOIN workspaces w ON w.id = r.workspace_id
     WHERE ci.id = $1 AND w.user_id = $2`, [id, userId]);
  if (!item) throw notFound('Checklist item');
  const verified = patch.user_verified ?? (patch.status !== undefined ? true : item.user_verified);
  const status = verified ? (patch.status ?? item.status) : (item.ai_status ?? 'pending');
  if (verified && status === 'pending') throw new HttpError(400, 'Choose a status before verifying this item.');
  await inTransaction(async (db) => {
    await db.query(
      `UPDATE checklist_items SET status = $2, user_verified = $3, user_note = CASE WHEN $5 THEN $4 ELSE user_note END, updated_at = now() WHERE id = $1`,
      [id, status, verified, patch.user_note ?? null, patch.user_note !== undefined]);
    await audit(db, { workspaceId: item.workspace_id, actor: 'user', actorId: userId, type: 'checklist.reviewed', entity: 'requirement', entityId: item.requirement_id,
      metadata: { from: item.status, to: status, user_verified: verified, ai_status: item.ai_status } });
  });
  return getRequirement(userId, item.requirement_id);
}

// --------------------------------------------------------------------- tasks

const TASKS_SQL = (filter: string, limit = 200) => `
  SELECT t.id, t.workspace_id, w.name AS workspace_name, t.checklist_item_id, t.title, t.notes, t.due_at, t.status, t.origin, t.created_at,
         coalesce((SELECT json_agg(json_build_object('id', r.id, 'scheduled_at', r.scheduled_at, 'delivery_status', r.delivery_status,
                     'channel', r.channel, 'detail', r.detail, 'sent_at', r.sent_at) ORDER BY r.scheduled_at)
                   FROM reminders r WHERE r.task_id = t.id), '[]'::json) AS reminders
  FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
  WHERE ${filter}
  ORDER BY (t.status = 'open') DESC, t.due_at NULLS LAST, t.created_at
  LIMIT ${limit}`;

export async function listTasks(userId: string, workspaceId: string): Promise<TaskDto[]> {
  await ownWorkspace(userId, workspaceId);
  return (await pool.query<TaskDto>(TASKS_SQL('t.workspace_id = $1'), [workspaceId])).rows;
}

const getTask = async (id: string) => (await one<TaskDto>(pool, TASKS_SQL('t.id = $1'), [id]))!;

export async function createTask(userId: string, workspaceId: string, input: { title: string; notes?: string | null; due_at?: string | null; checklist_item_id?: string | null }): Promise<TaskDto> {
  await ownWorkspace(userId, workspaceId);
  if (input.checklist_item_id) {
    const ok = await one(pool, `SELECT 1 FROM checklist_items ci JOIN requirements r ON r.id = ci.requirement_id WHERE ci.id = $1 AND r.workspace_id = $2`,
      [input.checklist_item_id, workspaceId]);
    if (!ok) throw notFound('Checklist item');
  }
  const { id } = (await one<{ id: string }>(pool,
    `INSERT INTO tasks (workspace_id, checklist_item_id, title, notes, due_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [workspaceId, input.checklist_item_id ?? null, input.title, input.notes ?? null, input.due_at ?? null]))!;
  await audit(pool, { workspaceId, actor: 'user', actorId: userId, type: 'task.created', entity: 'task', entityId: id });
  return getTask(id);
}

/** Marks a task's scheduled reminders and tells their workflows to stop. */
async function stopReminders(t: Temporal, taskId: string, status: 'suppressed' | 'cancelled', detail: string, send: (h: WorkflowHandle) => Promise<unknown>) {
  const { rows } = await pool.query<{ temporal_workflow_id: string }>(
    `UPDATE reminders SET delivery_status = $2, detail = $3 WHERE task_id = $1 AND delivery_status = 'scheduled' RETURNING temporal_workflow_id`,
    [taskId, status, detail]);
  await signalAll(t, [...new Set(rows.map((r) => r.temporal_workflow_id))], send);
}

export async function updateTask(t: Temporal, userId: string, id: string, patch: { title?: string; notes?: string | null; due_at?: string | null; status?: TaskDto['status'] }): Promise<TaskDto> {
  const task = await ownTask(userId, id);
  const set = setClause(patch, ['title', 'notes', 'due_at', 'status']);
  if (set.values.length) await pool.query(`UPDATE tasks SET ${set.sql}, updated_at = now() WHERE id = $1`, [id, ...set.values]);
  const closed = patch.status;
  if (closed && closed !== 'open' && task.status === 'open') {
    await stopReminders(t, id, 'suppressed', `task marked ${closed}`, (h) => h.signal(taskClosed, closed));
  }
  if (patch.status && patch.status !== task.status) {
    await audit(pool, { workspaceId: task.workspace_id, actor: 'user', actorId: userId, type: 'task.status_changed', entity: 'task', entityId: id, metadata: { from: task.status, to: patch.status } });
  }
  return getTask(id);
}

export async function deleteTask(t: Temporal, userId: string, id: string): Promise<void> {
  const task = await ownTask(userId, id);
  await stopReminders(t, id, 'cancelled', 'task deleted', (h) => h.signal(cancelReminders));
  await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
  await audit(pool, { workspaceId: task.workspace_id, actor: 'user', actorId: userId, type: 'task.deleted', entity: 'task', entityId: id });
}

/**
 * One reminder row per time, keyed `${taskId}:${time}`. Re-scheduling a time that
 * was already sent leaves it sent, so nobody is reminded twice for the same slot.
 */
export async function scheduleReminders(t: Temporal, userId: string, taskId: string, input: { remind_at: string[]; inject_failure?: string }): Promise<TaskDto> {
  const task = await ownTask(userId, taskId);
  if (task.status !== 'open') throw new HttpError(409, 'Reminders can only be set on open tasks.');
  const times = [...new Set(input.remind_at.map((s) => new Date(s).toISOString()))].filter((s) => Date.parse(s) > Date.now() - 5_000).sort();
  if (!times.length) throw new HttpError(400, 'Pick at least one reminder time in the future.');

  await stopReminders(t, taskId, 'cancelled', 'replaced by a new schedule', (h) => h.signal(cancelReminders));
  const { n } = (await one<{ n: number }>(pool, `SELECT count(*)::int + 1 AS n FROM workflow_runs WHERE subject_id = $1`, [taskId]))!;
  const workflowId = `reminders:${taskId}:${n}`;
  const rows = await inTransaction(async (db) => {
    const out: { id: string; scheduled_at: Date }[] = [];
    for (const at of times) {
      const row = await one<{ id: string; scheduled_at: Date }>(db,
        `INSERT INTO reminders (task_id, scheduled_at, idempotency_key, temporal_workflow_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (idempotency_key) DO UPDATE SET delivery_status = 'scheduled', temporal_workflow_id = EXCLUDED.temporal_workflow_id, detail = NULL
           WHERE reminders.delivery_status IN ('cancelled', 'suppressed', 'failed')
         RETURNING id, scheduled_at`, [taskId, at, `${taskId}:${at}`, workflowId]);
      if (row) out.push(row);
    }
    return out;
  });
  if (!rows.length) throw new HttpError(409, 'Reminders for those times were already sent.');
  try {
    await startRun(task.workspace_id, taskId, 'reminder', workflowId, () => t.workflow.start(reminderWorkflow, {
      workflowId, taskQueue: TASK_QUEUE,
      args: [{ taskId, reminders: rows.map((r) => ({ id: r.id, at: r.scheduled_at.toISOString() })), injectFailure: input.inject_failure }],
    }));
  } catch (err) {
    await pool.query(`UPDATE reminders SET delivery_status = 'failed', detail = 'could not schedule' WHERE temporal_workflow_id = $1 AND delivery_status = 'scheduled'`, [workflowId]);
    throw err;
  }
  await audit(pool, { workspaceId: task.workspace_id, actor: 'user', actorId: userId, type: 'reminders.scheduled', entity: 'task', entityId: taskId, metadata: { count: rows.length, workflow_id: workflowId } });
  return getTask(taskId);
}

export async function cancelTaskReminders(t: Temporal, userId: string, taskId: string): Promise<TaskDto> {
  const task = await ownTask(userId, taskId);
  await stopReminders(t, taskId, 'cancelled', 'cancelled by the user', (h) => h.signal(cancelReminders));
  await audit(pool, { workspaceId: task.workspace_id, actor: 'user', actorId: userId, type: 'reminders.cancelled', entity: 'task', entityId: taskId });
  return getTask(taskId);
}

// ------------------------------------------------------- search & assistant

async function viaAi<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new HttpError(502, `The AI provider is unavailable: ${(err as Error).message}`); // our own messages: no document text
  }
}

export async function search(userId: string, workspaceId: string, query: string): Promise<SearchHit[]> {
  await ownWorkspace(userId, workspaceId);
  const [embedding] = await viaAi(() => embed([query], 'query'));
  const hits = await hybridSearch({ workspaceId, query, embedding, limit: 10, roles: ['requirements', 'evidence'] });
  return hits.map(({ classification: _, expiry_date: __, ...h }) => h);
}

async function workspaceFacts(userId: string, workspaceId: string): Promise<string> {
  const [ws, reqs, docs, tasks] = await Promise.all([
    getWorkspace(userId, workspaceId), listRequirements(userId, workspaceId), listDocuments(userId, workspaceId), listTasks(userId, workspaceId),
  ]);
  const lines = [
    `Workspace: ${ws.name}${ws.institution ? ` (${ws.institution})` : ''}. Deadline: ${ws.deadline ?? 'not set'}. Today: ${new Date().toISOString().slice(0, 10)}.`,
    'Requirements and checklist status:',
    ...reqs.map((r) => {
      const c = r.checklist;
      const who = c?.user_verified ? 'verified by the user' : 'AI assessment, not verified';
      const ev = c?.evidence.map((e) => `${e.filename} p.${e.page_number ?? '?'}`).join(', ');
      return `- ${r.title} [${r.required ? 'required' : 'optional'}${r.confirmed ? '' : ', unconfirmed draft'}${r.due_date ? `, due ${r.due_date}` : ''}]: ` +
        `status ${c?.status ?? 'pending'} (${who})${c?.review_reason ? `; review reason: ${c.review_reason}` : ''}` +
        `${c?.explanation ? `; AI explanation: ${c.explanation}` : ''}${ev ? `; evidence: ${ev}` : ''}`;
    }),
    'Documents:',
    ...docs.map((d) => `- ${d.filename}: ${d.classification ?? 'unclassified'}, ${d.processing_status}${d.expiry_date ? `, expires ${d.expiry_date}` : ''}`),
    'Open tasks:',
    ...tasks.filter((x) => x.status === 'open').map((x) => `- ${x.title}${x.due_at ? `, due ${new Date(x.due_at).toISOString().slice(0, 10)}` : ''}`),
  ];
  return lines.join('\n');
}

export async function ask(userId: string, workspaceId: string, question: string): Promise<AnswerDto> {
  await ownWorkspace(userId, workspaceId);
  const [embedding] = await viaAi(() => embed([question], 'query'));
  const hits = await hybridSearch({ workspaceId, query: question, embedding, limit: 6, roles: ['requirements', 'evidence'] });
  const passages = hits.map((h, i) => ({ ...h, label: `P${i + 1}` }));
  const facts = await workspaceFacts(userId, workspaceId);
  const raw = await viaAi(() => chatJson(AiAnswer, 'answer_question', SYSTEM, answerPrompt(question, facts, passages)));
  return finalizeAnswer(raw, passages);
}

// ------------------------------------------------------------ runs & activity

interface RunRow extends Omit<RunDto, 'temporal_url' | 'steps'> {}
interface StepRow extends Omit<StepDto, 'sentry_url' | 'trace_url'> { workflow_id: string; sentry_event_id: string | null; trace_id: string | null }

async function runs(workspaceId: string, filter: { subjectId?: string; workflowId?: string; type?: string; limit?: number } = {}): Promise<RunDto[]> {
  const { rows } = await pool.query<RunRow>(
    `SELECT r.id, r.workflow_id, r.workflow_type, r.subject_id, coalesce(d.filename, t.title) AS subject_label,
            r.status, r.started_at, r.completed_at, r.last_error_summary
     FROM workflow_runs r LEFT JOIN documents d ON d.id = r.subject_id LEFT JOIN tasks t ON t.id = r.subject_id
     WHERE r.workspace_id = $1 AND ($2::uuid IS NULL OR r.subject_id = $2) AND ($3::text IS NULL OR r.workflow_id = $3) AND ($4::text IS NULL OR r.workflow_type = $4)
     ORDER BY r.started_at DESC LIMIT $5`,
    [workspaceId, filter.subjectId ?? null, filter.workflowId ?? null, filter.type ?? null, filter.limit ?? 30]);
  const { rows: steps } = await pool.query<StepRow>(
    `SELECT id::int, workflow_id, activity, attempt, outcome, duration_ms, error_summary, will_retry, sentry_event_id, trace_id, created_at
     FROM workflow_events WHERE workflow_id = ANY($1) ORDER BY id`, [rows.map((r) => r.workflow_id)]);
  return rows.map((r) => ({
    ...r,
    temporal_url: temporalLink(r.workflow_id),
    steps: steps.filter((s) => s.workflow_id === r.workflow_id).map(({ workflow_id: _, sentry_event_id, trace_id, ...s }) => ({
      ...s, sentry_url: sentryEventLink(sentry_event_id), trace_url: sentryTraceLink(trace_id),
    })),
  }));
}

const latestRun = async (workspaceId: string, type: string) => (await runs(workspaceId, { type, limit: 1 }))[0] ?? null;

export async function activity(userId: string, workspaceId: string): Promise<{ runs: RunDto[]; audit: AuditDto[] }> {
  await ownWorkspace(userId, workspaceId);
  const [runList, auditRows] = await Promise.all([
    runs(workspaceId),
    pool.query<AuditDto>(`SELECT * FROM audit_events WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100`, [workspaceId]),
  ]);
  return { runs: runList, audit: auditRows.rows };
}

/** The recorded run plus Temporal's live view of it. */
export async function workflowRun(t: Temporal, userId: string, workspaceId: string, workflowId: string): Promise<RunDto & { temporal_status: string | null }> {
  await ownWorkspace(userId, workspaceId);
  const [run] = await runs(workspaceId, { workflowId, limit: 1 });
  if (!run) throw notFound('Workflow');
  const temporal_status = await t.workflow.getHandle(workflowId).describe().then((d) => d.status.name, () => null);
  return { ...run, temporal_status };
}

// ---------------------------------------------------------------- dashboard

export async function dashboard(userId: string): Promise<DashboardDto> {
  const [workspaces, upcoming, processing, activityRows] = await Promise.all([
    listWorkspaces(userId),
    pool.query<TaskDto>(TASKS_SQL(`w.user_id = $1 AND t.status = 'open'`, 8), [userId]),
    pool.query<DocumentDto & { workspace_name: string }>(
      `SELECT ${docCols()}, w.name AS workspace_name FROM documents d JOIN workspaces w ON w.id = d.workspace_id
       WHERE w.user_id = $1 AND d.processing_status <> 'ready' ORDER BY d.created_at DESC LIMIT 10`, [userId]),
    pool.query<AuditDto>(
      `SELECT a.*, w.name AS workspace_name FROM audit_events a JOIN workspaces w ON w.id = a.workspace_id
       WHERE w.user_id = $1 ORDER BY a.created_at DESC LIMIT 15`, [userId]),
  ]);
  return { workspaces, upcoming: upcoming.rows, processing: processing.rows, activity: activityRows.rows };
}

// ------------------------------------------------------------------- report

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // no formula injection when opened in a spreadsheet
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export async function reportCsv(userId: string, workspaceId: string): Promise<{ filename: string; csv: string }> {
  const ws = await ownWorkspace(userId, workspaceId);
  const reqs = await listRequirements(userId, workspaceId);
  const rows: unknown[][] = [[
    'Requirement', 'Required', 'Status', 'Assessed by', 'Evidence (document, page)', 'Explanation', 'Review reason', 'Due date', 'Your note',
  ]];
  for (const r of reqs) {
    const c = r.checklist;
    const by = !r.confirmed ? 'Draft (not confirmed)' : c?.user_verified ? 'Verified by you' : c?.ai_status ? 'AI assessment (unverified)' : 'Not assessed';
    rows.push([
      r.title, r.required ? 'yes' : 'optional', c?.status ?? 'pending', by,
      c?.evidence.map((e) => `${e.filename} p.${e.page_number ?? '?'}`).join('; ') ?? '',
      c?.explanation ?? '', c?.review_reason ?? '', r.due_date ?? ws.deadline ?? '', c?.user_note ?? '',
    ]);
  }
  const slug = ws.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';
  return { filename: `papertrail-${slug}.csv`, csv: toCsv(rows) };
}
