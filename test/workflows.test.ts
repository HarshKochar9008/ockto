// Workflow behaviour on Temporal's time-skipping test server, with recorded fake activities.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/common';
import { WorkflowFailedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { Activities } from '../server/activities.ts';
import {
  analyzeWorkspaceWorkflow, processDocumentWorkflow, reminderWorkflow, retryFailedProcessingWorkflow, taskClosed,
} from '../server/workflows.ts';

let env: TestWorkflowEnvironment;
before(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); });
after(async () => { await env?.teardown(); });

const workflowsPath = fileURLToPath(new URL('../server/workflows.ts', import.meta.url));
const doc = { documentId: 'doc-1', workspaceId: 'ws-1' };

/** Fake activities that record what the workflow asked for, by name. */
function fakes(overrides: Partial<Activities> = {}) {
  const calls: string[] = [];
  const rec = <T>(name: string, value: T) => async (input?: unknown) => {
    const detail = (input as { status?: string; error?: string } | undefined);
    calls.push(detail?.status ? `${name}:${detail.status}` : name);
    return value;
  };
  const activities = {
    startDocument: rec('startDocument', undefined),
    extractText: rec('extractText', { pages: 1, reused: false }),
    classifyDocument: rec('classifyDocument', 'transcript'),
    indexDocument: rec('indexDocument', 3),
    extractRequirements: rec('extractRequirements', 5),
    finishDocument: async (i: { error?: string }) => { calls.push(i.error ? `finishDocument:failed` : 'finishDocument:ready'); },
    inspectDocument: rec('inspectDocument', null),
    requirementsToAssess: rec('requirementsToAssess', [] as string[]),
    assessRequirement: rec('assessRequirement', 'satisfied'),
    markAssessmentFailed: rec('markAssessmentFailed', undefined),
    syncTasks: rec('syncTasks', { opened: 0, closed: 0 }),
    deliverReminder: rec('deliverReminder', 'sent'),
    failReminder: rec('failReminder', undefined),
    closeReminders: rec('closeReminders', 0),
    finishRun: rec('finishRun', undefined),
    ...overrides,
  } as unknown as Activities;
  return { calls, activities };
}

async function withWorker<T>(activities: object, fn: (taskQueue: string) => Promise<T>): Promise<T> {
  const taskQueue = `test-${crypto.randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath, activities });
  return worker.runUntil(fn(taskQueue));
}

test('process document: evidence goes extract -> classify -> index, then marked ready', async () => {
  const { calls, activities } = fakes();
  await withWorker(activities, (taskQueue) =>
    env.client.workflow.execute(processDocumentWorkflow, { workflowId: 'p1', taskQueue, args: [{ ...doc, role: 'evidence' }] }));
  assert.deepEqual(calls, ['startDocument', 'extractText', 'classifyDocument', 'indexDocument', 'finishDocument:ready', 'finishRun:completed']);
});

test('process document: requirement sources are parsed into draft requirements, not classified', async () => {
  const { calls, activities } = fakes();
  await withWorker(activities, (taskQueue) =>
    env.client.workflow.execute(processDocumentWorkflow, { workflowId: 'p2', taskQueue, args: [{ ...doc, role: 'requirements' }] }));
  assert.deepEqual(calls.slice(1, 4), ['extractText', 'indexDocument', 'extractRequirements']);
});

test('a transient failure is retried without repeating completed steps', async () => {
  let attempts = 0;
  const { calls, activities } = fakes({
    classifyDocument: async () => {
      calls.push('classifyDocument');
      if (++attempts === 1) throw new Error('Ollama connection reset');
      return 'transcript';
    },
  });
  await withWorker(activities, (taskQueue) =>
    env.client.workflow.execute(processDocumentWorkflow, { workflowId: 'p3', taskQueue, args: [{ ...doc, role: 'evidence' }] }));
  assert.deepEqual(calls, ['startDocument', 'extractText', 'classifyDocument', 'classifyDocument', 'indexDocument', 'finishDocument:ready', 'finishRun:completed']);
});

test('a permanent failure marks the document failed with a safe summary, without retrying', async () => {
  let errorSeen = '';
  const { calls, activities } = fakes({
    extractText: async () => {
      calls.push('extractText');
      throw ApplicationFailure.nonRetryable('the PDF is password-protected', 'InvalidDocument');
    },
    finishDocument: async (i: { error?: string }) => { errorSeen = i.error ?? ''; calls.push('finishDocument:failed'); },
  });
  await withWorker(activities, async (taskQueue) => {
    await assert.rejects(
      env.client.workflow.execute(processDocumentWorkflow, { workflowId: 'p4', taskQueue, args: [{ ...doc, role: 'evidence' }] }),
      WorkflowFailedError);
  });
  assert.deepEqual(calls, ['startDocument', 'extractText', 'finishDocument:failed', 'finishRun:failed']);
  assert.equal(errorSeen, 'extractText: the PDF is password-protected');
});

test('retry workflow reuses extracted text and only runs the missing steps', async () => {
  const { calls, activities } = fakes({
    inspectDocument: async () => ({ role: 'evidence', hasText: true, classified: false, indexed: false, hasRequirements: false }),
  });
  const steps = await withWorker(activities, (taskQueue) =>
    env.client.workflow.execute(retryFailedProcessingWorkflow, { workflowId: 'r1', taskQueue, args: [doc] }));
  assert.deepEqual(steps, ['classifyDocument', 'indexDocument']);
  assert.ok(!calls.includes('extractText'));
});

test('analysis: one failing requirement goes to review, the rest are assessed, tasks are synced', async () => {
  const { calls, activities } = fakes({
    requirementsToAssess: async () => ['r1', 'r2', 'r3'],
    assessRequirement: async (i: { requirementId: string }) => {
      calls.push(`assess:${i.requirementId}`);
      if (i.requirementId === 'r2') throw ApplicationFailure.nonRetryable('AI model "gemma3:4b" not found', 'AiModelMissing');
      return 'satisfied';
    },
  });
  const res = await withWorker(activities, (taskQueue) =>
    env.client.workflow.execute(analyzeWorkspaceWorkflow, { workflowId: 'a1', taskQueue, args: [{ workspaceId: 'ws-1', version: 1 }] }));
  assert.deepEqual(res, { assessed: 2, failed: 1 });
  assert.deepEqual(calls.filter((c) => c !== 'requirementsToAssess'), [
    'assess:r1', 'assess:r2', 'markAssessmentFailed', 'assess:r3', 'syncTasks', 'finishRun:completed']);
});

// Workflow time is the test server's clock, which earlier time skips have moved ahead of ours.
const inADay = async () => new Date((await env.currentTimeMs()) + 86_400_000).toISOString();

test('reminder: durable timer fires on a new worker after the first one stops', async () => {
  const { calls, activities } = fakes();
  const taskQueue = `test-${crypto.randomUUID()}`;
  const handle = await env.client.workflow.start(reminderWorkflow, {
    workflowId: 'rem1', taskQueue, args: [{ taskId: 't1', reminders: [{ id: 'rm1', at: await inADay() }] }],
  });
  // Worker #1 picks the workflow up and parks it on its timer, then goes away ("restart").
  // No cache = no sticky queue: like a crashed process, it leaves nothing for the next task to be routed to.
  const w1 = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath, activities, maxCachedWorkflows: 0 });
  await w1.runUntil(async () => { while ((await handle.describe()).historyLength < 5) await new Promise((r) => setTimeout(r, 50)); });
  assert.deepEqual(calls, []);
  // Worker #2 (fresh process state) resumes from history; time skips past the timer.
  const w2 = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath, activities });
  await w2.runUntil(handle.result());
  assert.deepEqual(calls, ['deliverReminder', 'finishRun:completed']);
});

test('reminder: completing the task before the timer means it is never sent', async () => {
  const { calls, activities } = fakes();
  await withWorker(activities, async (taskQueue) => {
    const handle = await env.client.workflow.start(reminderWorkflow, {
      workflowId: 'rem2', taskQueue, args: [{ taskId: 't2', reminders: [{ id: 'a', at: await inADay() }, { id: 'b', at: await inADay() }] }],
    });
    await handle.signal(taskClosed, 'done');
    await handle.result();
  });
  assert.deepEqual(calls, ['closeReminders:suppressed', 'finishRun:completed']);
});

test('reminder: a task closed without a signal is caught by the pre-send check', async () => {
  const { calls, activities } = fakes({ deliverReminder: async () => { calls.push('deliverReminder'); return 'suppressed'; } });
  await withWorker(activities, async (taskQueue) => env.client.workflow.execute(reminderWorkflow, {
    workflowId: 'rem3', taskQueue, args: [{ taskId: 't3', reminders: [{ id: 'a', at: await inADay() }, { id: 'b', at: await inADay() }] }],
  }));
  assert.deepEqual(calls, ['deliverReminder', 'closeReminders:suppressed', 'finishRun:completed']);
});
