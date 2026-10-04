import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

// DATE columns come back as 'YYYY-MM-DD' strings, not midnight-local Date objects.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_MAX ?? 10) });

// pg emits 'error' when a connection dies (DB restart, failover); unhandled, it
// kills the process. The pending query still rejects, and the pool discards the
// dead client, so logging is all that's left to do.
const logConnectionError = (err: Error) => console.error(`pg connection error: ${err.message}`);
pool.on('error', logConnectionError); // idle clients

export type Db = pg.Pool | pg.PoolClient;

export async function inTransaction<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  db.on('error', logConnectionError); // checked-out clients have no pool listener
  try {
    await db.query('BEGIN');
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.off('error', logConnectionError);
    db.release();
  }
}

export async function one<T extends pg.QueryResultRow>(db: Db, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await db.query<T>(sql, params)).rows[0];
}

/** Applies migrations/NNN_*.sql in order, each once, each in its own transaction. */
export async function migrate(dir = new URL('../migrations/', import.meta.url)): Promise<string[]> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const name of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    const sql = await readFile(new URL(name, dir), 'utf8');
    await inTransaction(async (db) => {
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
    applied.push(name);
  }
  return applied;
}

/** Audit trail entry; also marks the workspace as recently active. Never put document text or secrets in metadata. */
export async function audit(
  db: Db,
  e: { workspaceId: string; actor: 'user' | 'system' | 'ai'; actorId?: string | null; type: string; entity: string; entityId?: string | null; metadata?: Record<string, unknown> },
): Promise<void> {
  await db.query(
    `WITH touch AS (UPDATE workspaces SET updated_at = now() WHERE id = $1)
     INSERT INTO audit_events (workspace_id, actor_type, actor_id, event_type, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.workspaceId, e.actor, e.actorId ?? null, e.type, e.entity, e.entityId ?? null, e.metadata ?? {}],
  );
}
