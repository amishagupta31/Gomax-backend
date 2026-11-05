import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import type { Config } from '../config.js';
import * as schema from './schema.js';

/** A database handle or an open transaction — both work everywhere. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const isLocal = (url: string) => /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

/**
 * Pool settings for Supabase. The URL's own sslmode is dropped so TLS is
 * controlled here: verified against DB_CA_CERT when given, otherwise
 * encrypted-only (allowed outside production; loadConfig enforces the CA there).
 * Transaction-pooler friendly: no session state, no named prepared statements.
 */
export function poolConfig(c: Config, url = c.DATABASE_URL, max = c.DB_POOL_MAX): pg.PoolConfig {
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  const ssl = isLocal(url) ? false : c.DB_CA_CERT ? { ca: c.DB_CA_CERT, rejectUnauthorized: true } : { rejectUnauthorized: false };
  return { connectionString: u.toString(), ssl, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 };
}

export function createDb(c: Config) {
  const pool = new pg.Pool(poolConfig(c));
  const db = drizzle(pool, { schema }) as unknown as Db;
  return { db, pool, close: () => pool.end() };
}
