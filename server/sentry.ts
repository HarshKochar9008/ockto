// Worker-side observability. One activity interceptor that:
//  - tags Sentry scope and the active span with workflow / activity / attempt,
//  - reports failures to Sentry (first failure and final failure, not every retry),
//  - journals every attempt into workflow_events, which drives the activity page.
import { fileURLToPath } from 'node:url';
import { trace, TraceFlags } from '@opentelemetry/api';
import * as Sentry from '@sentry/node';
import type { Info } from '@temporalio/activity';
import { ApplicationFailure, ApplicationFailureCategory, CancelledFailure } from '@temporalio/common';
import { SimplePlugin } from '@temporalio/plugin';
import type { InjectedSinks } from '@temporalio/worker';
import { pool } from './db.ts';
import { temporalLink } from './temporal.ts';
import type { SentrySinks } from './workflow-interceptors.ts';

const errorType = (err: unknown) =>
  err instanceof ApplicationFailure ? (err.type ?? err.name) : err instanceof Error ? err.name : 'unknown';

type RetryInfo = Pick<Info, 'attempt' | 'retryPolicy'>;

/** False when Temporal will not run this activity again. */
export function willRetry(err: unknown, info: RetryInfo): boolean {
  if (err instanceof CancelledFailure) return false;
  if (err instanceof ApplicationFailure && err.nonRetryable) return false;
  if (info.retryPolicy?.nonRetryableErrorTypes?.includes(errorType(err))) return false;
  const max = info.retryPolicy?.maximumAttempts ?? 0; // 0 / unset = unlimited
  return max === 0 || info.attempt < max;
}

/**
 * First failure (so a transient error that later recovers is still visible) and the
 * final one. Middle retries are skipped; all events share a fingerprint, so one issue.
 */
export function shouldReport(err: unknown, info: RetryInfo): boolean {
  if (err instanceof CancelledFailure) return false;
  if (err instanceof ApplicationFailure && err.category === ApplicationFailureCategory.BENIGN) return false;
  return info.attempt === 1 || !willRetry(err, info);
}

const safeMessage = (err: unknown) => (err instanceof Error ? `${errorType(err)}: ${err.message}` : String(err)).slice(0, 300);

function sampledTraceId(): string | null {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx && ctx.traceFlags & TraceFlags.SAMPLED ? ctx.traceId : null;
}

async function journal(i: Info, row: { outcome: 'completed' | 'failed'; ms: number; error?: string; willRetry?: boolean; eventId?: string | null; traceId: string | null }) {
  const workflowId = i.workflowExecution?.workflowId;
  if (!workflowId) return;
  await pool.query(
    `INSERT INTO workflow_events (workflow_id, activity, attempt, outcome, duration_ms, error_summary, will_retry, sentry_event_id, trace_id)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9 WHERE EXISTS (SELECT 1 FROM workflow_runs WHERE workflow_id = $1)`,
    [workflowId, i.activityType, i.attempt, row.outcome, Math.round(row.ms), row.error ?? null, row.willRetry ?? null, row.eventId ?? null, row.traceId],
  ).catch((err: Error) => console.error(`workflow journal write failed: ${err.message}`)); // never fail the activity over it
}

// Must be listed AFTER OpenTelemetryPlugin: plugins append interceptors and the
// first is outermost, so this runs inside the RunActivity span.
export const sentryPlugin = new SimplePlugin({
  name: 'sentry',
  workerInterceptors: {
    activity: [(ctx) => ({
      inbound: {
        execute: (input, next) => Sentry.withIsolationScope(async (scope) => {
          const i = ctx.info;
          const wf = i.workflowExecution;
          const args = input.args[0] as { workspaceId?: string; documentId?: string } | undefined;
          const tags = {
            'temporal.workflow_type': i.workflowType,
            'temporal.workflow_id': wf?.workflowId,
            'temporal.activity_type': i.activityType,
            'temporal.attempt': i.attempt,
            // Opaque UUIDs only: no names, file names or document text.
            'papertrail.workspace_id': args?.workspaceId,
            'papertrail.document_id': args?.documentId,
          };
          scope.setTags(tags);
          trace.getActiveSpan()?.setAttributes(Object.fromEntries(Object.entries(tags).filter(([, v]) => v !== undefined)) as Record<string, string | number>);
          scope.setContext('temporal', {
            namespace: i.namespace, activityId: i.activityId, runId: wf?.runId,
            link: wf ? temporalLink(wf.workflowId, wf.runId) : undefined,
          });
          const started = performance.now();
          try {
            const result = await next(input);
            await journal(i, { outcome: 'completed', ms: performance.now() - started, traceId: sampledTraceId() });
            return result;
          } catch (err) {
            let eventId: string | null = null;
            if (shouldReport(err, i)) {
              scope.setFingerprint(['temporal-activity', i.workflowType ?? 'standalone', i.activityType, errorType(err)]);
              const id = Sentry.captureException(err);
              eventId = Sentry.isEnabled() ? id : null;
            }
            await journal(i, {
              outcome: 'failed', ms: performance.now() - started, error: safeMessage(err),
              willRetry: willRetry(err, i), eventId, traceId: sampledTraceId(),
            });
            throw err; // Temporal owns retries
          }
        }),
      },
    })],
    workflowModules: [fileURLToPath(new URL('./workflow-interceptors.ts', import.meta.url))],
  },
});

export const sentrySinks: InjectedSinks<SentrySinks> = {
  sentry: {
    workflowFailed: {
      fn(info, type, message, stack) {
        Sentry.withScope((scope) => {
          scope.setTags({ 'temporal.workflow_type': info.workflowType, 'temporal.workflow_id': info.workflowId });
          scope.setContext('temporal', { namespace: info.namespace, runId: info.runId, link: temporalLink(info.workflowId, info.runId) });
          scope.setFingerprint(['temporal-workflow', info.workflowType, type]);
          Sentry.captureException(Object.assign(new Error(message), { name: type, stack }));
        });
      },
    },
  },
};
