// Runs inside Temporal's deterministic sandbox: no I/O, no Node APIs, no clock
// other than workflow time. Every side effect is an activity (see activities.ts).
import { ApplicationFailureCategory } from '@temporalio/common';
import {
  ActivityFailure, ApplicationFailure, CancellationScope, condition, defineSignal, isCancellation,
  proxyActivities, setHandler, workflowInfo,
} from '@temporalio/workflow';
import type { Activities, DocInput } from './activities.ts';

const retry = { initialInterval: '2 seconds', backoffCoefficient: 2, maximumInterval: '1 minute', maximumAttempts: 5 };

// Bookkeeping in Postgres: quick, retried for a few minutes.
const db = proxyActivities<Activities>({ startToCloseTimeout: '30 seconds', retry: { ...retry, maximumAttempts: 10 } });
// Files and model calls: slow on CPU-only Gemma; heartbeats every 10 s.
const work = proxyActivities<Activities>({ startToCloseTimeout: '15 minutes', heartbeatTimeout: '1 minute', retry });
// Webhook delivery: fail fast, retry a bounded number of times.
const notify = proxyActivities<Activities>({ startToCloseTimeout: '30 seconds', retry });

/** Safe, short text for the UI: the failing activity and its message, never a stack or payload. */
function summary(err: unknown): string {
  if (err instanceof ActivityFailure) return `${err.activityType}: ${err.cause?.message ?? err.message}`.slice(0, 300);
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** Records the outcome, then fails the run as BENIGN: the activity error was already reported to Sentry. */
async function failRun(err: unknown, onFail: (error: string) => Promise<void>): Promise<never> {
  const { workflowId } = workflowInfo();
  if (isCancellation(err)) {
    await CancellationScope.nonCancellable(() => db.finishRun({ workflowId, status: 'cancelled' }));
    throw err;
  }
  const error = summary(err);
  await CancellationScope.nonCancellable(async () => {
    await onFail(error);
    await db.finishRun({ workflowId, status: 'failed', error });
  });
  throw ApplicationFailure.create({ message: error, type: 'RunFailed', nonRetryable: true, category: ApplicationFailureCategory.BENIGN });
}

// ------------------------------------------------------------ documents (A, D)

type DocStep = 'extractText' | 'classifyDocument' | 'indexDocument' | 'extractRequirements';

async function runDocumentSteps(input: DocInput, steps: DocStep[]): Promise<void> {
  await db.startDocument(input);
  try {
    for (const step of steps) await work[step](input);
  } catch (err) {
    return failRun(err, (error) => db.finishDocument({ documentId: input.documentId, error }));
  }
  await db.finishDocument({ documentId: input.documentId });
  await db.finishRun({ workflowId: workflowInfo().workflowId, status: 'completed' });
}

/** A: Upload -> extract text (PDF parser or OCR) -> classify -> chunk + embed + index; requirement sources are also parsed into draft requirements. */
export async function processDocumentWorkflow(input: DocInput & { role: 'requirements' | 'evidence' }): Promise<void> {
  await runDocumentSteps(input, input.role === 'requirements'
    ? ['extractText', 'indexDocument', 'extractRequirements']
    : ['extractText', 'classifyDocument', 'indexDocument']);
}

/** D: Re-runs only the steps whose results are missing; earlier runs and their errors stay on record. */
export async function retryFailedProcessingWorkflow(input: DocInput): Promise<DocStep[]> {
  const state = await db.inspectDocument(input);
  if (!state) {
    await db.finishRun({ workflowId: workflowInfo().workflowId, status: 'failed', error: 'the document no longer exists' });
    return [];
  }
  const steps: DocStep[] = [];
  if (!state.hasText) steps.push('extractText');
  if (state.role === 'evidence' && !state.classified) steps.push('classifyDocument');
  if (!state.indexed) steps.push('indexDocument');
  if (state.role === 'requirements' && !state.hasRequirements) steps.push('extractRequirements');
  await runDocumentSteps(input, steps);
  return steps;
}

// ------------------------------------------------------------------ analysis (B)

/**
 * B: Assesses every confirmed requirement against the indexed documents for
 * analysis `version`. One failing requirement is flagged for review; the rest carry on.
 */
export async function analyzeWorkspaceWorkflow(input: { workspaceId: string; version: number; injectFailure?: string }): Promise<{ assessed: number; failed: number }> {
  const { workspaceId, version } = input;
  try {
    const ids = await db.requirementsToAssess(input);
    let failed = 0;
    for (const [i, requirementId] of ids.entries()) {
      try {
        await work.assessRequirement({ workspaceId, requirementId, version, injectFailure: i === 0 ? input.injectFailure : undefined });
      } catch (err) {
        if (isCancellation(err)) throw err;
        failed++;
        await db.markAssessmentFailed({ workspaceId, requirementId, version, error: summary(err) });
      }
    }
    await db.syncTasks(input);
    const allFailed = failed > 0 && failed === ids.length;
    await db.finishRun({
      workflowId: workflowInfo().workflowId,
      status: allFailed ? 'failed' : 'completed',
      error: failed ? `${failed} of ${ids.length} requirements could not be assessed` : undefined,
    });
    return { assessed: ids.length - failed, failed };
  } catch (err) {
    return failRun(err, async () => {});
  }
}

// ----------------------------------------------------------------- reminders (C)

export const taskClosed = defineSignal<[status: 'done' | 'dismissed']>('taskClosed');
export const cancelReminders = defineSignal('cancelReminders');

/**
 * C: Durable timers, one per reminder. Survives worker and API restarts. Each
 * delivery re-reads the task, so a task completed while the signal was lost is still not nagged about.
 */
export async function reminderWorkflow(input: { taskId: string; reminders: { id: string; at: string }[]; injectFailure?: string }): Promise<void> {
  // Set from signal handlers; the assertion stops TS narrowing it to `undefined` below.
  let stop = undefined as { status: 'suppressed' | 'cancelled'; detail: string } | undefined;
  setHandler(taskClosed, (s) => { stop ??= { status: 'suppressed', detail: `task marked ${s}` }; });
  setHandler(cancelReminders, () => { stop ??= { status: 'cancelled', detail: 'cancelled by the user' }; });

  for (const [i, r] of input.reminders.entries()) {
    const wait = Date.parse(r.at) - Date.now(); // workflow time: deterministic on replay
    if (wait > 0) await condition(() => stop !== undefined, wait);
    if (stop) break;
    try {
      const outcome = await notify.deliverReminder({ reminderId: r.id, injectFailure: i === 0 ? input.injectFailure : undefined });
      if (outcome === 'suppressed') {
        stop = { status: 'suppressed', detail: 'task already closed' };
        break;
      }
    } catch (err) {
      if (isCancellation(err)) throw err;
      await db.failReminder({ reminderId: r.id, error: summary(err) }); // retries exhausted; later reminders still go out
    }
  }
  if (stop) await db.closeReminders({ taskId: input.taskId, workflowId: workflowInfo().workflowId, ...stop });
  await db.finishRun({ workflowId: workflowInfo().workflowId, status: 'completed' });
}
