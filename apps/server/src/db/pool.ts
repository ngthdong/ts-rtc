import { readdir, readFile } from 'node:fs/promises';
import { SignalingError } from '@ts-rtc/protocol';
import pg from 'pg';

export type Db = pg.Pool;

export function createPool(connectionString: string): Db {
  const db = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 2_000,
    query_timeout: 5_000,
  });
  db.on('error', () => undefined); // an idle client died (Postgres restarted): the pool replaces it
  return db;
}

/**
 * SQL errors are answers (a constraint) or bugs and are rethrown; anything else (refused,
 * timed out, server shutting down) means the database is unreachable: UNAVAILABLE, retryable.
 */
export async function query<R extends pg.QueryResultRow>(
  db: Db,
  text: string,
  values: unknown[] = [],
): Promise<R[]> {
  try {
    return (await db.query<R>(text, values)).rows;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const sqlState = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
    if (sqlState && !/^(08|57)/.test(code)) throw err;
    throw new SignalingError('UNAVAILABLE', 'database unavailable', undefined, { cause: err });
  }
}

const MIGRATIONS = new URL('../../migrations/', import.meta.url);

/** Applies migrations/*.sql in name order, each once and in a transaction; one server at a time. */
export async function migrate(db: Db, dir = MIGRATIONS): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock(7140)');
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = await client.query<{ name: string }>('select name from schema_migrations');
    const skip = new Set(done.rows.map((r) => r.name));
    for (const name of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      if (skip.has(name)) continue;
      await client.query('begin');
      try {
        await client.query(await readFile(new URL(name, dir), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
      applied.push(name);
    }
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock(7140)').catch(() => undefined);
    client.release();
  }
}
