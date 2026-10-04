// Real Postgres for integration tests: a separate database (created if missing),
// migrated and emptied. Call before importing anything from server/ (it reads env at import).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

export async function useTestDatabase(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:papertrail@localhost:5440/papertrail_test';
  const name = new URL(url).pathname.slice(1);
  const admin = new pg.Client({ connectionString: url.replace(`/${name}`, '/postgres') });
  await admin.connect().catch((err: Error) => {
    throw new Error(`integration tests need Postgres at ${new URL(url).host} (docker compose up -d db): ${err.message}`);
  });
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  Object.assign(process.env, {
    DATABASE_URL: url, NODE_ENV: 'test', STORAGE_DRIVER: 'local', STORAGE_DIR: mkdtempSync(join(tmpdir(), 'papertrail-test-')),
    DEMO_FAILURE_INJECTION: 'true', MAX_UPLOAD_MB: '1', AI_BASE_URL: 'http://127.0.0.1:9/v1', REMINDER_WEBHOOK_URL: '',
  });
  const { migrate, pool } = await import('../server/db.ts');
  await migrate();
  await pool.query('TRUNCATE users, workspaces CASCADE');
}
