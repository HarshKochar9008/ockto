import { fileURLToPath } from 'node:url';
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry-v2';
import { NativeConnection, Worker } from '@temporalio/worker';
import { activities, withFailureInjection } from './activities.ts';
import { pool } from './db.ts';
import { resource, shutdownTelemetry, spanProcessor } from './instrument.ts';
import { sentryPlugin, sentrySinks } from './sentry.ts';
import { TASK_QUEUE, namespace, temporalConnection } from './temporal.ts';

const worker = await Worker.create({
  connection: await NativeConnection.connect(temporalConnection),
  namespace,
  taskQueue: TASK_QUEUE,
  workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
  activities: process.env.DEMO_FAILURE_INJECTION === 'true' ? withFailureInjection(activities) : activities,
  plugins: [new OpenTelemetryPlugin({ resource, spanProcessor }), sentryPlugin], // order matters, see sentry.ts
  sinks: sentrySinks,
  // Local Gemma serves one request at a time; more concurrent model calls just queue inside Ollama.
  maxConcurrentActivityTaskExecutions: Number(process.env.MAX_CONCURRENT_ACTIVITIES ?? 4),
  // The heap-based default ignores sandbox memory outside the V8 heap.
  maxCachedWorkflows: Number(process.env.MAX_CACHED_WORKFLOWS ?? 200),
});

try {
  await worker.run(); // returns after SIGINT/SIGTERM and a graceful drain
} finally {
  await pool.end();
  await shutdownTelemetry();
}
