// Runs pending SQL migrations. In production this is the Cloud Run Job
// `gomax-migrate`, executed by Cloud Build before each deploy. Uses
// DIRECT_URL (Supabase session pooler): migrations need a session connection.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { poolConfig } from './client.js';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function main() {
  const c = loadConfig();
  const pool = new pg.Pool(poolConfig(c, c.DIRECT_URL || c.DATABASE_URL, 1));
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    console.log('migrations applied');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
