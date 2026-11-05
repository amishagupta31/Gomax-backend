import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import { MIGRATIONS_DIR } from '../src/db/migrate.js';
import * as schema from '../src/db/schema.js';
import { seedCatalogue, seedOwner } from '../src/db/seed.js';
import { mockKyc, type KycProvider } from '../src/lib/kyc.js';
import type { PhoneVerifier } from '../src/lib/firebase.js';
import type { RazorpayClient } from '../src/lib/razorpay.js';
import { memoryStore } from '../src/lib/storage.js';
import { logWhatsApp } from '../src/lib/whatsapp.js';

export const OWNER = { loginId: 'owner', password: 'owner-pass-123', pin: '1234' };

/** True when the suite runs on a real Postgres server (TEST_DATABASE_URL). */
export const REAL_DB = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Fresh database for one test file.
 * - Default: in-memory Postgres (PGlite) — fast, no install, but it runs one
 *   query at a time, so it can't exercise real lock contention.
 * - TEST_DATABASE_URL=postgres://…/postgres: a brand-new database on a real
 *   Postgres server (dropped afterwards), with a real connection pool, so
 *   concurrent requests truly run in parallel.
 */
async function freshDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const lite = new PGlite();
    await migrate(drizzle(lite), { migrationsFolder: MIGRATIONS_DIR });
    return { db: drizzle(lite, { schema }) as unknown as Db, close: () => lite.close() };
  }
  const name = `gomax_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(url);
  u.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 30 });
  await migratePg(drizzlePg(pool), { migrationsFolder: MIGRATIONS_DIR });
  return {
    db: drizzlePg(pool, { schema }) as unknown as Db,
    close: async () => {
      await pool.end();
      const a = new pg.Client({ connectionString: url });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** A fresh app on a fresh database with a movable clock. */
export async function setup(opts: { kyc?: KycProvider; env?: Record<string, string>; verifyPhone?: PhoneVerifier; razorpay?: RazorpayClient } = {}) {
  const { db, close: closeDb } = await freshDb();
  await seedCatalogue(db);
  await seedOwner(db, OWNER.loginId, OWNER.password, OWNER.pin);

  // Monday 12 Oct 2026, 10:30 am IST.
  let t = new Date('2026-10-12T05:00:00Z');
  const clock = {
    now: () => new Date(t),
    set: (d: string | Date) => void (t = new Date(d)),
    advance: (ms: number) => void (t = new Date(t.getTime() + ms)),
    days: (n: number) => void (t = new Date(t.getTime() + n * 86_400_000)),
  };
  const wa = logWhatsApp();
  const store = memoryStore();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite://memory',
    JWT_SECRET: randomBytes(32).toString('hex'),
    PAN_KEY: randomBytes(32).toString('base64'),
    JOBS_SECRET: 'jobs-secret',
    ...opts.env,
  });
  const app = await buildApp({ db, config, store, wa, kyc: opts.kyc ?? mockKyc(), now: clock.now, verifyPhone: opts.verifyPhone, razorpay: opts.razorpay });

  type Res = { status: number; body: any };
  const call = async (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const r = await app.inject({
      method: method as 'GET',
      url,
      payload: payload as object,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    let body: unknown = r.body;
    try {
      body = r.json();
    } catch {
      /* csv / text */
    }
    return { status: r.statusCode, body };
  };
  const api = (token?: string) => ({
    get: (url: string) => call('GET', url, token),
    post: (url: string, payload?: unknown) => call('POST', url, token, payload ?? {}),
    put: (url: string, payload?: unknown) => call('PUT', url, token, payload ?? {}),
    patch: (url: string, payload?: unknown) => call('PATCH', url, token, payload ?? {}),
  });

  let seq = 0;
  /** Signs up an applicator; returns its token, id and an api bound to it. */
  const signup = async (opts: { name?: string; referralCode?: string; deviceId?: string } = {}) => {
    const mobile = `9${String(100000000 + ++seq).slice(-9)}`;
    const r = await api().post('/v1/auth/signup', { name: opts.name ?? `User ${seq}`, mobile, password: 'secret123', referralCode: opts.referralCode, deviceId: opts.deviceId ?? `dev-${seq}` });
    if (r.status !== 200) throw new Error(`signup failed ${JSON.stringify(r.body)}`);
    return { ...r.body.user, token: r.body.accessToken as string, refresh: r.body.refreshToken as string, api: api(r.body.accessToken) };
  };

  const ownerLogin = async () => {
    const r = await api().post('/v1/admin/auth/login', OWNER);
    if (r.status !== 200) throw new Error(`owner login failed ${JSON.stringify(r.body)}`);
    return api(r.body.accessToken);
  };

  /** Creates an in-market batch through the admin API and returns its codes. */
  const makeCodes = async (owner: ReturnType<typeof api>, quantity: number, valuePoints = 20, line = 'standard') => {
    const b = await owner.post('/v1/admin/coupon-batches', { valuePoints, quantity, line });
    if (b.status !== 200) throw new Error(JSON.stringify(b.body));
    await owner.patch(`/v1/admin/coupon-batches/${b.body.id}`, { status: 'printed' });
    await owner.patch(`/v1/admin/coupon-batches/${b.body.id}`, { status: 'in_market' });
    const rows = await db.select({ code: schema.coupons.code }).from(schema.coupons).where(eq(schema.coupons.batchId, b.body.id)).orderBy(schema.coupons.serial);
    return { batchId: b.body.id as number, codes: rows.map((r) => r.code) };
  };

  /** Adds PAN + UPI so withdrawals are allowed. */
  const kyc = async (user: { api: ReturnType<typeof api>; name: string }) => {
    const p = await user.api.post('/v1/me/kyc/pan', { pan: 'ABCDE1234F', name: user.name });
    if (p.status !== 200) throw new Error(JSON.stringify(p.body));
    const u = await user.api.put('/v1/me/kyc/upi', { upiId: 'ram@ybl' });
    if (u.status !== 200) throw new Error(JSON.stringify(u.body));
  };

  const runJob = (name: string) => call('POST', `/internal/jobs/${name}`, undefined, {}, { 'x-jobs-secret': 'jobs-secret' });

  return { app, db, clock, wa, store, config, api, signup, ownerLogin, makeCodes, kyc, runJob, close: async () => { await app.close(); await closeDb(); } };
}

export type Ctx = Awaited<ReturnType<typeof setup>>;
