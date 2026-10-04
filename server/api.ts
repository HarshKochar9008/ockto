import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { pool } from './db.ts';
import { shutdownTelemetry } from './instrument.ts';
import { connectTemporal } from './temporal.ts';

const app = buildApp({ temporal: await connectTemporal(), webDist: fileURLToPath(new URL('../web/dist', import.meta.url)) });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
    await shutdownTelemetry();
    process.exit(0);
  });
}

await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
