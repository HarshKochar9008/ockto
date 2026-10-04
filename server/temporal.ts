// Shared by the API and the worker: Temporal connection, task queue, and deep links.
import { Client, Connection } from '@temporalio/client';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry-v2';

// ponytail: one task queue; split model-heavy activities onto their own queue
// once slow Gemma calls start starving quick database activities of worker slots.
export const TASK_QUEUE = 'papertrail';

const apiKey = process.env.TEMPORAL_API_KEY;
export const temporalConnection = {
  address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  ...(apiKey ? { apiKey, tls: true } : {}), // Temporal Cloud
};
export const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';

export async function connectTemporal(): Promise<Client> {
  return new Client({
    connection: await Connection.connect(temporalConnection),
    namespace,
    // Carries the W3C trace context into workflows, so API -> workflow -> activity is one trace.
    interceptors: { workflow: [new OpenTelemetryWorkflowClientInterceptor()] },
  });
}

export const temporalUiUrl = process.env.TEMPORAL_UI_URL ?? 'http://localhost:8233';
export const temporalLink = (workflowId: string, runId?: string) =>
  `${temporalUiUrl}/namespaces/${namespace}/workflows/${encodeURIComponent(workflowId)}${runId ? `/${runId}/history` : ''}`;

// e.g. https://my-org.sentry.io — without it, event ids are stored but not linked.
const sentryOrgUrl = process.env.SENTRY_ORG_URL?.replace(/\/$/, '');
export const sentryEventLink = (eventId: string | null) => (sentryOrgUrl && eventId ? `${sentryOrgUrl}/issues/?query=${eventId}` : null);
export const sentryTraceLink = (traceId: string | null) => (sentryOrgUrl && traceId ? `${sentryOrgUrl}/explore/traces/trace/${traceId}/` : null);
