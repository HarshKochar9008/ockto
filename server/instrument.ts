// Loaded first via `node --import ./server/instrument.ts`, so the HTTP
// instrumentation patches node:http before Fastify loads it.
//
// OpenTelemetry owns tracing; Sentry v11 reports errors and stamps them with the
// active OTel span. Spans go to Sentry's OTLP endpoint, and W3C traceparent is the
// only propagation format (the Temporal workflow sandbox speaks nothing else).
import { basename } from 'node:path';
import * as Sentry from '@sentry/node';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor, NoopSpanProcessor, ParentBasedSampler, SamplingDecision, TraceIdRatioBasedSampler,
  type Sampler, type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ApplicationFailure, ApplicationFailureCategory, CancelledFailure } from '@temporalio/common';

const dsn = process.env.SENTRY_DSN || undefined;
const otlp = dsn ? Sentry.getOtlpTracesEndpoint(dsn) : undefined;
if (dsn && !otlp) throw new Error('SENTRY_DSN is not a valid DSN');

export const resource = resourceFromAttributes({
  'service.name': process.env.OTEL_SERVICE_NAME ?? `papertrail-${basename(process.argv[1] ?? 'app', '.ts')}`,
});

// The one span processor: the NodeSDK uses it for API and activity spans, and
// Temporal's OpenTelemetryPlugin uses it for spans exported out of the workflow sandbox.
export const spanProcessor: SpanProcessor = otlp
  ? new BatchSpanProcessor(new OTLPTraceExporter(otlp))
  : new NoopSpanProcessor();

const rate = new TraceIdRatioBasedSampler(Number(process.env.TRACE_RATE ?? 1));
const root: Sampler = {
  shouldSample(ctx, traceId, _name, _kind, attrs) {
    const path = String(attrs['url.path'] ?? '');
    // Health checks and static assets are noise.
    if (path === '/healthz' || (path && !path.startsWith('/api/'))) return { decision: SamplingDecision.NOT_RECORD };
    return rate.shouldSample(ctx, traceId);
  },
  toString: () => 'PaperTrailRootSampler',
};

const otel = new NodeSDK({
  resource,
  spanProcessors: [spanProcessor],
  sampler: new ParentBasedSampler({ root }),
  instrumentations: [new HttpInstrumentation()],
});
otel.start(); // before Sentry.init, as Sentry's own-OTel-pipeline setup requires

Sentry.init({
  dsn,
  environment: process.env.SENTRY_ENVIRONMENT,
  enableOpenTelemetrySetup: false, // already the v11 default; explicit so nobody "fixes" it
  integrations: [Sentry.openTelemetryIntegration()],
  // v11 collects bodies, headers and cookies by default: that would ship session
  // cookies, passwords and uploaded documents to Sentry.
  dataCollection: { httpBodies: [], httpHeaders: false, cookies: false, userInfo: false, urlQueryParams: false },
  beforeSend(event, hint) {
    const err = hint.originalException;
    if (err instanceof CancelledFailure) return null; // cancellation / worker shutdown
    if (err instanceof ApplicationFailure && err.category === ApplicationFailureCategory.BENIGN) return null;
    delete event.user;
    if (event.request) event.request = { method: event.request.method, url: event.request.url?.split('?')[0] };
    return event;
  },
});

export async function shutdownTelemetry(): Promise<void> {
  await Sentry.close(5000);
  await otel.shutdown(); // flushes the batch processor, including workflow spans
}
