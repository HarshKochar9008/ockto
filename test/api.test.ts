// HTTP + Postgres integration: authorization, upload validation, deletion, reminders, audit.
// Real database; only Temporal is faked (its behaviour is covered in workflows.test.ts).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { useTestDatabase } from './setup.ts';

await useTestDatabase();
const { pool } = await import('../server/db.ts');
const { buildApp } = await import('../server/app.ts');
const { hybridSearch } = await import('../server/retrieval.ts');
const { activities } = await import('../server/activities.ts');
const { makePdf } = await import('../scripts/demo-docs.ts');

const started: { type: string; workflowId: string; args: any[] }[] = [];
const signals: string[] = [];
const temporal = {
  workflow: {
    start: async (fn: { name: string }, o: { workflowId: string; args: any[] }) => { started.push({ type: fn.name, workflowId: o.workflowId, args: o.args }); },
    getHandle: (id: string) => ({
      signal: async (s: { name: string }) => { signals.push(`${id}:${s.name}`); },
      cancel: async () => { signals.push(`${id}:cancel`); },
      describe: async () => ({ status: { name: 'RUNNING' } }),
    }),
  },
} as any;
const app = buildApp({ temporal });
after(async () => { await app.close(); await pool.end(); });

type Res = { statusCode: number; json: () => any; body: string; headers: Record<string, any> };
const req = async (cookie: string, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res> =>
  app.inject({ method: method as any, url, payload: payload as any, headers: { cookie, ...headers } }) as unknown as Res;

async function signup(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { email, name: email, password: 'correct horse battery' } });
  assert.equal(res.statusCode, 201);
  return String(res.headers['set-cookie']).split(';')[0];
}
const upload = (cookie: string, ws: string, bytes: Buffer, type = 'application/pdf', query = '') =>
  req(cookie, 'POST', `/api/v1/workspaces/${ws}/documents${query}`, bytes, { 'content-type': type, 'x-filename': encodeURIComponent('transcript (1).pdf') });

const alice = await signup('alice@example.test');
const bob = await signup('bob@example.test');
const ws = (await req(alice, 'POST', '/api/v1/workspaces', { name: 'Uni', deadline: '2027-01-15' })).json().id as string;
const pdf = makePdf([['Official academic transcript. Cumulative GPA 3.7.']]);

test('unauthenticated and cross-site requests are refused', async () => {
  assert.equal((await req('', 'GET', '/api/v1/workspaces')).statusCode, 401);
  assert.equal((await req(alice, 'GET', '/api/v1/workspaces')).statusCode, 200);
  const crossSite = await req(alice, 'POST', '/api/v1/workspaces', { name: 'x' }, { origin: 'https://evil.example' });
  assert.equal(crossSite.statusCode, 403);
  const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'alice@example.test', password: 'wrong password' } });
  assert.equal(bad.statusCode, 401);
});

test('uploads are validated by their bytes, deduplicated, and start a workflow', async () => {
  assert.equal((await upload(alice, ws, Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0]), 'application/pdf')).statusCode, 415); // an .exe
  assert.equal((await upload(alice, ws, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'application/pdf')).statusCode, 415); // PNG claiming PDF
  assert.equal((await upload(alice, ws, Buffer.alloc(2 * 1024 * 1024, 'a'), 'text/plain')).statusCode, 413);
  assert.equal((await req(alice, 'POST', `/api/v1/workspaces/${ws}/documents`, { not: 'a file' })).statusCode, 415);

  const first = await upload(alice, ws, pdf, 'application/pdf', '?inject_failure=extractText');
  assert.equal(first.statusCode, 201);
  const doc = first.json().document;
  assert.equal(doc.filename, 'transcript (1).pdf');
  assert.equal(doc.processing_status, 'queued');
  assert.deepEqual(started.at(-1), {
    type: 'processDocumentWorkflow', workflowId: `process-document:${doc.id}`,
    args: [{ documentId: doc.id, workspaceId: ws, role: 'evidence', injectFailure: 'extractText' }],
  });
  const again = await upload(alice, ws, pdf);
  assert.deepEqual([again.statusCode, again.json().duplicate, again.json().document.id], [200, true, doc.id]);
  assert.equal(started.filter((s) => s.type === 'processDocumentWorkflow').length, 1);
  const runs = await pool.query('SELECT workflow_type, status FROM workflow_runs WHERE subject_id = $1', [doc.id]);
  assert.deepEqual(runs.rows, [{ workflow_type: 'processDocument', status: 'running' }]);
});

test("a user cannot reach another user's records by changing ids", async () => {
  const doc = (await upload(alice, ws, makePdf([['Passport photo page.']]))).json().document;
  const reqId = (await req(alice, 'POST', `/api/v1/workspaces/${ws}/requirements`, { title: 'Passport' })).json().id;
  const item = (await req(alice, 'GET', `/api/v1/requirements/${reqId}`)).json().checklist.id;
  const task = (await req(alice, 'POST', `/api/v1/workspaces/${ws}/tasks`, { title: 'Get passport copy' })).json().id;
  const attempts: [string, string, unknown?][] = [
    ['GET', `/api/v1/workspaces/${ws}`], ['PATCH', `/api/v1/workspaces/${ws}`, { name: 'mine' }], ['DELETE', `/api/v1/workspaces/${ws}`],
    ['GET', `/api/v1/workspaces/${ws}/documents`], ['GET', `/api/v1/documents/${doc.id}`], ['GET', `/api/v1/documents/${doc.id}/file`],
    ['POST', `/api/v1/documents/${doc.id}/retry`, {}], ['DELETE', `/api/v1/documents/${doc.id}`],
    ['GET', `/api/v1/requirements/${reqId}`], ['PATCH', `/api/v1/requirements/${reqId}`, { title: 'x' }], ['DELETE', `/api/v1/requirements/${reqId}`],
    ['PATCH', `/api/v1/checklist/${item}`, { status: 'satisfied' }], ['POST', `/api/v1/workspaces/${ws}/analyze`, {}],
    ['PATCH', `/api/v1/tasks/${task}`, { status: 'done' }], ['POST', `/api/v1/tasks/${task}/reminders`, { remind_at: [new Date(Date.now() + 3_600_000).toISOString()] }],
    ['DELETE', `/api/v1/tasks/${task}`], ['GET', `/api/v1/workspaces/${ws}/activity`], ['GET', `/api/v1/workspaces/${ws}/report.csv`],
    ['POST', `/api/v1/workspaces/${ws}/search`, { query: 'passport' }], ['POST', `/api/v1/workspaces/${ws}/ask`, { question: 'what is missing?' }],
  ];
  for (const [method, url, body] of attempts) {
    const res = await req(bob, method, url, body);
    assert.equal(res.statusCode, 404, `${method} ${url} answered ${res.statusCode}`);
  }
  assert.equal((await upload(bob, ws, makePdf([['bob file']]))).statusCode, 404);
  assert.equal((await req(bob, 'GET', '/api/v1/workspaces')).json().length, 0);
  assert.equal((await req(alice, 'GET', `/api/v1/documents/${doc.id}`)).statusCode, 200); // still there
});

test('deleting a document removes it from retrieval and sends what it supported back to review', async () => {
  const doc = (await upload(alice, ws, makePdf([['Language certificate: overall score 7.0.']]))).json().document;
  const reqId = (await req(alice, 'POST', `/api/v1/workspaces/${ws}/requirements`, { title: 'English test' })).json().id;
  const vector = JSON.stringify(Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)));
  const { rows: [chunk] } = await pool.query(
    `INSERT INTO document_chunks (document_id, workspace_id, chunk_index, page_number, content, embedding)
     VALUES ($1, $2, 0, 1, 'Language certificate: overall score 7.0.', $3) RETURNING id`, [doc.id, ws, vector]);
  const { rows: [item] } = await pool.query(`UPDATE checklist_items SET status = 'satisfied', ai_status = 'satisfied', assessment_version = 1 WHERE requirement_id = $1 RETURNING id`, [reqId]);
  await pool.query(`INSERT INTO evidence_matches (checklist_item_id, document_id, chunk_id, page_number, excerpt, assessment_version) VALUES ($1, $2, $3, 1, 'overall score 7.0', 1)`, [item.id, doc.id, chunk.id]);
  const search = () => hybridSearch({ workspaceId: ws, query: 'language certificate score', embedding: JSON.parse(vector) });
  assert.ok((await search()).some((h) => h.document_id === doc.id));
  const { rows: [{ storage_key }] } = await pool.query('SELECT storage_key FROM documents WHERE id = $1', [doc.id]);
  assert.ok(existsSync(join(process.env.STORAGE_DIR!, storage_key)));

  assert.equal((await req(alice, 'DELETE', `/api/v1/documents/${doc.id}`)).statusCode, 204);
  assert.ok(!(await search()).some((h) => h.document_id === doc.id));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1', [doc.id])).rows[0].n, 0);
  assert.ok(!existsSync(join(process.env.STORAGE_DIR!, storage_key)));
  const after = (await req(alice, 'GET', `/api/v1/requirements/${reqId}`)).json().checklist;
  assert.equal(after.status, 'needs_review');
  assert.match(after.review_reason, /was deleted/);
  assert.equal(after.evidence.length, 0);
  assert.ok(signals.includes(`process-document:${doc.id}:cancel`));
});

test('a human decision outranks later AI assessments and is audited', async () => {
  const reqId = (await req(alice, 'POST', `/api/v1/workspaces/${ws}/requirements`, { title: 'Personal statement' })).json().id;
  const item = (await req(alice, 'GET', `/api/v1/requirements/${reqId}`)).json().checklist.id;
  const reviewed = (await req(alice, 'PATCH', `/api/v1/checklist/${item}`, { status: 'satisfied', user_note: 'Emailed separately' })).json().checklist;
  assert.deepEqual([reviewed.status, reviewed.user_verified, reviewed.user_note], ['satisfied', true, 'Emailed separately']);
  await activities.markAssessmentFailed({ workspaceId: ws, requirementId: reqId, version: 1, error: 'model offline' }); // a later AI write
  const now = (await req(alice, 'GET', `/api/v1/requirements/${reqId}`)).json().checklist;
  assert.deepEqual([now.status, now.ai_status, now.user_verified], ['satisfied', 'needs_review', true]);
  const { rows } = await pool.query(`SELECT metadata FROM audit_events WHERE entity_id = $1 AND event_type = 'checklist.reviewed'`, [reqId]);
  assert.deepEqual(rows[0].metadata, { from: 'pending', to: 'satisfied', user_verified: true, ai_status: null });
  // Editing the requirement voids the verification: the user verified a different text.
  await req(alice, 'PATCH', `/api/v1/requirements/${reqId}`, { description: 'Max 1,000 words' });
  assert.equal((await req(alice, 'GET', `/api/v1/requirements/${reqId}`)).json().checklist.user_verified, false);
});

test('reminders: completing the task suppresses them; already-sent slots are never re-sent', async () => {
  const task = (await req(alice, 'POST', `/api/v1/workspaces/${ws}/tasks`, { title: 'Request recommendation letters' })).json().id;
  const t1 = new Date(Date.now() + 3_600_000).toISOString();
  const t2 = new Date(Date.now() + 7_200_000).toISOString();
  const scheduled = await req(alice, 'POST', `/api/v1/tasks/${task}/reminders`, { remind_at: [t2, t1, t1] });
  assert.equal(scheduled.statusCode, 201);
  const run = started.at(-1)!;
  assert.equal(run.type, 'reminderWorkflow');
  assert.deepEqual(run.args[0].reminders.map((r: { at: string }) => r.at), [t1, t2]); // deduped, ordered

  await pool.query(`UPDATE reminders SET delivery_status = 'sent', sent_at = now() WHERE task_id = $1 AND scheduled_at = $2`, [task, t1]);
  const done = (await req(alice, 'PATCH', `/api/v1/tasks/${task}`, { status: 'done' })).json();
  assert.deepEqual(done.reminders.map((r: { delivery_status: string }) => r.delivery_status), ['sent', 'suppressed']);
  assert.ok(signals.includes(`${run.workflowId}:taskClosed`));
  assert.equal((await req(alice, 'POST', `/api/v1/tasks/${task}/reminders`, { remind_at: [t2] })).statusCode, 409); // closed task

  await req(alice, 'PATCH', `/api/v1/tasks/${task}`, { status: 'open' });
  await req(alice, 'POST', `/api/v1/tasks/${task}/reminders`, { remind_at: [t1, t2] });
  assert.deepEqual(started.at(-1)!.args[0].reminders.map((r: { at: string }) => r.at), [t2]); // t1 was already sent
  const cancelled = (await req(alice, 'DELETE', `/api/v1/tasks/${task}/reminders`)).json();
  assert.deepEqual(cancelled.reminders.map((r: { delivery_status: string }) => r.delivery_status), ['sent', 'cancelled']);
});

test('reminders: after a reschedule the old workflow can neither deliver nor cancel the new schedule', async () => {
  const { MockActivityEnvironment } = await import('@temporalio/testing');
  const as = (workflowId: string) => new MockActivityEnvironment({ workflowExecution: { workflowId, runId: 'r' } } as never);
  const task = (await req(alice, 'POST', `/api/v1/workspaces/${ws}/tasks`, { title: 'Book language test' })).json().id;
  const at = new Date(Date.now() + 3_600_000).toISOString();
  await req(alice, 'POST', `/api/v1/tasks/${task}/reminders`, { remind_at: [at] });
  const oldRun = started.at(-1)!;
  await req(alice, 'POST', `/api/v1/tasks/${task}/reminders`, { remind_at: [at] }); // same slot, new workflow
  const newRun = started.at(-1)!;
  const reminderId = newRun.args[0].reminders[0].id;
  assert.equal(reminderId, oldRun.args[0].reminders[0].id); // same row, revived

  // The old workflow got its cancel signal late: its cleanup and its timer must both be no-ops.
  assert.equal(await as(oldRun.workflowId).run(activities.closeReminders, { taskId: task, workflowId: oldRun.workflowId, status: 'cancelled' as const, detail: 'late' }), 0);
  assert.equal(await as(oldRun.workflowId).run(activities.deliverReminder, { reminderId }), 'cancelled');
  assert.equal(await as(newRun.workflowId).run(activities.deliverReminder, { reminderId }), 'sent');
  assert.equal(await as(newRun.workflowId).run(activities.deliverReminder, { reminderId }), 'sent'); // a retry does not send twice
  const { rows } = await pool.query(`SELECT delivery_status, channel FROM reminders WHERE id = $1`, [reminderId]);
  assert.deepEqual(rows, [{ delivery_status: 'sent', channel: 'in_app' }]);
});

test('the CSV report separates AI assessments from user verification and defuses formulas', async () => {
  const evil = (await req(alice, 'POST', `/api/v1/workspaces/${ws}/requirements`, { title: '=HYPERLINK("http://evil.example")' })).json();
  await req(alice, 'PATCH', `/api/v1/checklist/${evil.checklist.id}`, { status: 'not_applicable' });
  const res = await req(alice, 'GET', `/api/v1/workspaces/${ws}/report.csv`);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.body, /not_applicable,Verified by you/);
  assert.match(res.body, /needs_review,AI assessment \(unverified\)/);
  assert.match(res.body, /"'=HYPERLINK\(""http:\/\/evil.example""\)"/);
  assert.doesNotMatch(res.body, /^=|,=/m);
});
