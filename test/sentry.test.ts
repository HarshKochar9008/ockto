// An injected activity failure is captured by Sentry (tagged, once), retried by
// Temporal, and journaled with its Sentry event id for the activity page.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as Sentry from '@sentry/node';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { useTestDatabase } from './setup.ts';

await useTestDatabase();
const { pool } = await import('../server/db.ts');
const { withFailureInjection } = await import('../server/activities.ts');
const { sentryPlugin, sentrySinks } = await import('../server/sentry.ts');
const { processDocumentWorkflow } = await import('../server/workflows.ts');

const events: Sentry.ErrorEvent[] = [];
Sentry.init({ dsn: 'https://public@o0.ingest.sentry.io/0', beforeSend: (e) => { events.push(e); return null; } }); // nothing leaves the process

let env: TestWorkflowEnvironment;
before(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); });
after(async () => { await env?.teardown(); await pool.end(); });

test('injected failure: reported to Sentry once, retried, journaled with the event id', async () => {
  const { rows: [{ id: userId }] } = await pool.query(`INSERT INTO users (email, name, password_hash) VALUES ('s@example.test', 's', 'x') RETURNING id`);
  const { rows: [{ id: workspaceId }] } = await pool.query(`INSERT INTO workspaces (user_id, name) VALUES ($1, 'w') RETURNING id`, [userId]);
  const workflowId = 'process-document:sentry-test';
  await pool.query(`INSERT INTO workflow_runs (workspace_id, workflow_id, workflow_type) VALUES ($1, $2, 'processDocument')`, [workspaceId, workflowId]);

  const ok = async () => undefined;
  const fakes = {
    startDocument: ok, extractText: async () => ({ pages: 1, reused: false }), classifyDocument: async () => 'transcript',
    indexDocument: async () => 1, finishDocument: ok, finishRun: ok,
  };
  const taskQueue = `test-${crypto.randomUUID()}`;
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue, workflowsPath: fileURLToPath(new URL('../server/workflows.ts', import.meta.url)),
    activities: withFailureInjection(fakes), plugins: [sentryPlugin], sinks: sentrySinks,
  });
  await worker.runUntil(env.client.workflow.execute(processDocumentWorkflow, {
    workflowId, taskQueue, args: [{ documentId: '00000000-0000-0000-0000-000000000001', workspaceId, role: 'evidence', injectFailure: 'extractText' }],
  }));
  await Sentry.flush(2000);

  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.exception?.values?.[0]?.type, 'InjectedFailure');
  assert.equal(event.tags?.['temporal.activity_type'], 'extractText');
  assert.equal(event.tags?.['temporal.attempt'], 1);
  assert.equal(event.tags?.['papertrail.workspace_id'], workspaceId);
  assert.equal(event.request, undefined); // no request bodies, headers or cookies

  const { rows } = await pool.query(
    `SELECT activity, attempt, outcome, will_retry, sentry_event_id FROM workflow_events WHERE workflow_id = $1 AND activity = 'extractText' ORDER BY id`, [workflowId]);
  assert.deepEqual(rows, [
    { activity: 'extractText', attempt: 1, outcome: 'failed', will_retry: true, sentry_event_id: event.event_id },
    { activity: 'extractText', attempt: 2, outcome: 'completed', will_retry: null, sentry_event_id: null },
  ]);
});
