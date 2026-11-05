// Load-test data for a STAGING (or local) database — never prod.
//
//   DATABASE_URL=<staging session-pooler URL> [DB_CA_CERT_FILE=prod-ca-2021.crt] \
//     npx tsx load/seed.ts --users 20000 --codes 300000
//
// Creates:
//   - users 6000000000 … 6000000000+N-1, password "loadtest123", WhatsApp
//     updates OFF (so no message is ever queued for these numbers);
//   - one in-market coupon batch (10 points each) and writes its codes to
//     load/data/codes.json for k6.
// Safe to re-run: existing load users are kept; each run adds a new batch.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../src/db/schema.js';
import { couponBatches, coupons, users } from '../src/db/schema.js';
import { hashSecret } from '../src/lib/crypto.js';
import { generateCode } from '../src/lib/codes.js';

export const LOAD_MOBILE_BASE = 6_000_000_000;
export const LOAD_PASSWORD = 'loadtest123';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL (staging session pooler, port 5432)');
  if (process.env.APP_ENV === 'prod') throw new Error('Refusing to seed load-test data into prod');
  const nUsers = arg('users', 2000);
  const nCodes = arg('codes', 50_000);
  const host = new URL(url).hostname;
  console.log(`Seeding ${nUsers} users + ${nCodes} codes into ${host}`);

  const local = /^(localhost|127\.0\.0\.1)$/.test(host);
  const ca = process.env.DB_CA_CERT_FILE ? readFileSync(process.env.DB_CA_CERT_FILE, 'utf8') : undefined;
  const pool = new pg.Pool({ connectionString: url, max: 4, ssl: local ? false : ca ? { ca } : { rejectUnauthorized: false } });
  const db = drizzle(pool, { schema });
  try {
    // One argon2 hash shared by every load user (hashing 20k separately takes minutes).
    const passwordHash = await hashSecret(LOAD_PASSWORD);
    for (let i = 0; i < nUsers; i += 1000) {
      const rows = Array.from({ length: Math.min(1000, nUsers - i) }, (_, k) => {
        const n = i + k;
        return {
          mobile: String(LOAD_MOBILE_BASE + n),
          name: `Load User ${n}`,
          passwordHash,
          inviteCode: `LT${n}`,
          city: 'Amritsar',
          whatsappOptIn: false,
          lastDeviceId: `load-device-${n}`,
        };
      });
      await db.insert(users).values(rows).onConflictDoNothing();
      process.stdout.write(`\r  users ${Math.min(i + 1000, nUsers)}/${nUsers}`);
    }
    console.log();

    const [batch] = await db
      .insert(couponBatches)
      .values({
        ref: `LT-${Date.now().toString(36).toUpperCase()}`.slice(0, 12),
        valuePoints: 10,
        quantity: nCodes,
        status: 'in_market',
        expiresAt: new Date(Date.now() + 365 * 86_400_000),
        inMarketAt: new Date(),
        note: 'Load test batch — safe to delete',
      })
      .returning();
    const codes: string[] = [];
    for (let s = 1; s <= nCodes; s += 5000) {
      const rows = Array.from({ length: Math.min(5000, nCodes - s + 1) }, (_, k) => ({ code: generateCode(), batchId: batch.id, serial: s + k }));
      const ins = await db.insert(coupons).values(rows).onConflictDoNothing({ target: coupons.code }).returning({ code: coupons.code });
      codes.push(...ins.map((r) => r.code));
      process.stdout.write(`\r  codes ${codes.length}/${nCodes}`);
    }
    console.log();

    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'codes.json'), JSON.stringify(codes));
    writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ users: nUsers, mobileBase: LOAD_MOBILE_BASE, password: LOAD_PASSWORD, batch: batch.ref, codes: codes.length }, null, 2));
    console.log(`Batch ${batch.ref} · ${codes.length} codes → load/data/codes.json`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
