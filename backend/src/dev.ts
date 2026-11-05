// Zero-setup local API: embedded Postgres (PGlite) saved in ./.data, demo
// data, WhatsApp messages printed to the console, uploads kept in memory.
//   npm run dev:local   → http://localhost:8080
// Demo applicator 98765 43210 / gomax123 · admin owner / owner-pass-123 (PIN 1234 for money approvals)
// Settings come from .env if it exists. PAYOUT_MODE=razorpayx with no Razorpay
// keys uses a local stand-in (src/lib/razorpay-dev.ts); with test keys
// (rzp_test_…) it talks to RazorpayX test mode.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import type { Db } from './db/client.js';
import { MIGRATIONS_DIR } from './db/migrate.js';
import * as schema from './db/schema.js';
import { seedCatalogue, seedDemo, seedOwner } from './db/seed.js';
import { mockKyc, razorpayKyc } from './lib/kyc.js';
import { razorpayClient } from './lib/razorpay.js';
import { devRazorpay } from './lib/razorpay-dev.js';
import { memoryStore } from './lib/storage.js';
import { logWhatsApp } from './lib/whatsapp.js';

mkdirSync('.data', { recursive: true });
const pg = new PGlite('.data/pg');
await migrate(drizzle(pg), { migrationsFolder: MIGRATIONS_DIR });
const db = drizzle(pg, { schema }) as unknown as Db;
await seedCatalogue(db);
await seedOwner(db, 'owner', 'owner-pass-123', '1234');
await seedDemo(db);

const rzpKeys = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAYX_ACCOUNT_NUMBER);
const rzpStandIn = process.env.PAYOUT_MODE === 'razorpayx' && !rzpKeys;
const config = loadConfig({
  ...process.env,
  ...(rzpStandIn && { RAZORPAY_KEY_ID: 'dev', RAZORPAY_KEY_SECRET: 'dev', RAZORPAYX_ACCOUNT_NUMBER: 'DEV-ACCOUNT', KYC_DRIVER: 'mock' }),
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || (rzpStandIn ? 'dev-webhook-secret' : undefined),
  NODE_ENV: 'development',
  DATABASE_URL: 'pglite://.data/pg',
  JWT_SECRET: process.env.JWT_SECRET ?? randomBytes(32).toString('hex'),
  PAN_KEY: Buffer.alloc(32, 7).toString('base64'), // dev only: this local database's own key, never .env's
  JOBS_SECRET: process.env.JOBS_SECRET ?? 'dev-jobs',
});
const razorpay = rzpStandIn
  ? devRazorpay()
  : rzpKeys
    ? razorpayClient({ keyId: config.RAZORPAY_KEY_ID!, keySecret: config.RAZORPAY_KEY_SECRET!, accountNumber: config.RAZORPAYX_ACCOUNT_NUMBER! })
    : undefined;
const kyc = config.KYC_DRIVER === 'razorpay' && razorpay ? razorpayKyc(razorpay) : mockKyc();
const app = await buildApp({ db, config, store: memoryStore(), wa: logWhatsApp((m) => console.log(m)), kyc, razorpay, now: () => new Date() });
await app.listen({ host: '0.0.0.0', port: config.PORT });

// Send queued WhatsApp messages every 30 s, like Cloud Scheduler would.
setInterval(() => void app.inject({ method: 'POST', url: '/internal/jobs/outbox', headers: { 'x-jobs-secret': config.JOBS_SECRET! } }), 30_000);
console.log(`GoMax API on http://localhost:${config.PORT} (PGlite in ./.data)`);
if (config.PAYOUT_MODE === 'razorpayx') {
  console.log(`Payouts: RazorpayX ${rzpStandIn ? 'local stand-in (no keys)' : 'with your keys'} · send now: POST /internal/jobs/payouts (x-jobs-secret: ${config.JOBS_SECRET})`);
}
