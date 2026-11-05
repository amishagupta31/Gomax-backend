import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { setup, type Ctx } from './helpers.js';

let c: Ctx;
beforeAll(async () => {
  c = await setup();
});
afterAll(async () => {
  await c.close();
});

describe('A1 auth', () => {
  test('signup → login → refresh rotation → logout', async () => {
    const api = c.api();
    const s = await api.post('/v1/auth/signup', { name: 'Ram Kumar', mobile: '98765 43210', password: 'gomax123', city: 'Amritsar' });
    expect(s.status).toBe(200);
    expect(s.body.user.mobile).toBe('9876543210');
    expect(s.body.user.inviteCode).toMatch(/^RAM\d{3}$/);

    expect((await api.post('/v1/auth/signup', { name: 'Ram K', mobile: '9876543210', password: 'gomax123' })).body.error.code).toBe('mobile_taken');

    const l = await api.post('/v1/auth/login', { mobile: '+91 98765 43210', password: 'gomax123' });
    expect(l.status).toBe(200);
    const r1 = await api.post('/v1/auth/refresh', { refreshToken: l.body.refreshToken });
    expect(r1.status).toBe(200);
    // The old refresh token was rotated out.
    expect((await api.post('/v1/auth/refresh', { refreshToken: l.body.refreshToken })).status).toBe(401);
    await api.post('/v1/auth/logout', { refreshToken: r1.body.refreshToken });
    expect((await api.post('/v1/auth/refresh', { refreshToken: r1.body.refreshToken })).status).toBe(401);
  });

  test('3 wrong passwords pause login for 30 min (A1-05)', async () => {
    const u = await c.signup();
    const api = c.api();
    const wrong = () => api.post('/v1/auth/login', { mobile: u.mobile, password: 'nope12345' });
    const a = await wrong();
    expect(a.status).toBe(401);
    expect(a.body.error.triesLeft).toBe(2);
    expect((await wrong()).body.error.triesLeft).toBe(1);
    const p = await wrong();
    expect(p.status).toBe(423);
    expect(p.body.error.code).toBe('paused');
    // Even the right password is refused while paused.
    expect((await api.post('/v1/auth/login', { mobile: u.mobile, password: 'secret123' })).status).toBe(423);
    c.clock.advance(31 * 60_000);
    expect((await api.post('/v1/auth/login', { mobile: u.mobile, password: 'secret123' })).status).toBe(200);
  });

  test('unknown number and weak password', async () => {
    const api = c.api();
    expect((await api.post('/v1/auth/login', { mobile: '9000000001', password: 'x' })).body.error.code).toBe('not_registered');
    const weak = await api.post('/v1/auth/signup', { name: 'A B', mobile: '9000000002', password: 'abcdefgh' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('invalid_input');
  });

  test('referral code lookup and bad code', async () => {
    const inviter = await c.signup({ name: 'Ramesh Traders' });
    const api = c.api();
    expect((await api.get(`/v1/auth/referral/${inviter.inviteCode.toLowerCase()}`)).body.name).toBe('Ramesh Traders');
    expect((await api.get('/v1/auth/referral/NOPE99')).status).toBe(404);
    const bad = await api.post('/v1/auth/signup', { name: 'X Y', mobile: '9000000003', password: 'secret123', referralCode: 'NOPE99' });
    expect(bad.body.error.code).toBe('bad_referral');
  });

  test('password reset over WhatsApp: only the owner of the number, link works once', async () => {
    const u = await c.signup({ name: 'Suresh' });
    const send = (from: string, text: string) =>
      c.api().post('/webhooks/whatsapp', { entry: [{ changes: [{ value: { messages: [{ from, type: 'text', text: { body: text } }] } }] }] });

    // From a different number: ignored.
    await send('919999999999', `RESET ${u.mobile}`);
    await c.runJob('outbox');
    expect(c.wa.sent.find((m) => m.template === 'password_reset' && m.to === u.mobile)).toBeUndefined();

    await send(`91${u.mobile}`, `reset ${u.mobile.slice(0, 5)} ${u.mobile.slice(5)}`);
    await c.runJob('outbox');
    const msg = c.wa.sent.find((m) => m.template === 'password_reset' && m.to === u.mobile)!;
    expect(msg).toBeTruthy();
    const token = new URL(msg.vars.link).searchParams.get('t')!;

    const api = c.api();
    expect((await api.post('/v1/auth/reset-password', { token, password: 'newpass99' })).status).toBe(200);
    expect((await api.post('/v1/auth/reset-password', { token, password: 'other999' })).body.error.code).toBe('link_expired');
    expect((await api.post('/v1/auth/login', { mobile: u.mobile, password: 'newpass99' })).status).toBe(200);
    // Old sessions were signed out.
    expect((await api.post('/v1/auth/refresh', { refreshToken: u.refresh })).status).toBe(401);
  });

  test('protected routes need a token; staff tokens are not user tokens', async () => {
    expect((await c.api().get('/v1/home')).status).toBe(401);
    const owner = await c.ownerLogin();
    expect((await owner.get('/v1/home')).status).toBe(401);
    const u = await c.signup();
    expect((await u.api.get('/v1/admin/dashboard')).status).toBe(401);
  });

  test('products are info only; owner replaces the TDS PDF (C1 / D9a)', async () => {
    const owner = await c.ownerLogin();
    const u = await c.signup();
    const list = await u.api.get('/v1/products');
    expect(list.body.products.map((p: { id: string }) => p.id)).toEqual(['p10', 'p40', 'is100', 'hg1200', 'urp', 'iwl']);
    expect(JSON.stringify(list.body)).not.toMatch(/points|price/i);
    expect((await u.api.get('/v1/products/p10/tds')).status).toBe(404);
    const up = await owner.post('/v1/admin/uploads', { purpose: 'tds', contentType: 'application/pdf' });
    const p10 = list.body.products[0];
    const { id, name, category, tds, ...data } = p10;
    void tds;
    expect((await owner.put(`/v1/admin/products/${id}`, { name, category, data, sort: 1, tdsObject: up.body.object, tdsBytes: 1_048_576 })).status).toBe(200);
    const tdsRes = await u.api.get('/v1/products/p10/tds');
    expect(tdsRes.body).toMatchObject({ bytes: 1_048_576 });
    expect(tdsRes.body.url).toContain(up.body.object);
  });

  test('audit log is append-only', async () => {
    const owner = await c.ownerLogin();
    await owner.post('/v1/admin/coupon-batches', { valuePoints: 10, quantity: 1 });
    await expect(c.db.execute(sql`update gomax.audit_log set action = 'x'`)).rejects.toThrow();
    await expect(c.db.execute(sql`delete from gomax.audit_log`)).rejects.toThrow();
  });

  test('every GoMax table has row-level security on (Supabase lockdown)', async () => {
    const r = await c.db.execute(sql`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'gomax' and c.relkind = 'r'`);
    const rows = (r as unknown as { rows: { relname: string; relrowsecurity: boolean }[] }).rows;
    expect(rows.length).toBe(30); // + dealers, home_cards, content_pages (0005)
    expect(rows.filter((x) => !x.relrowsecurity)).toEqual([]);
  });

  test('readyz checks the database', async () => {
    const r = await c.api().get('/readyz');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, db: 'fulfilled', redis: 'not configured' });
  });
});
