// The remaining catalogue cases (TEST_CASES.md): helpline request, gift
// unlocked by a scan, UPI name mismatch, full-PAN view, WhatsApp signature.
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, helplineRequests } from '../src/db/schema.js';
import { mockKyc, namesMatch, type KycProvider } from '../src/lib/kyc.js';
import { setup, type Ctx } from './helpers.js';

// UPI lookups return a registered name; "ram.other@ybl" belongs to someone else.
const kyc: KycProvider = {
  verifyPan: mockKyc().verifyPan,
  async lookupUpi(upi) {
    if (upi === 'ram.other@ybl') return { ok: true, name: 'SURESH KUMAR' };
    return mockKyc().lookupUpi(upi);
  },
};

let c: Ctx;
beforeAll(async () => {
  c = await setup({ kyc, env: { WA_APP_SECRET: 'meta-app-secret' } });
});
afterAll(async () => {
  await c.close();
});

describe('remaining catalogue cases', () => {
  test('AUTH-18 helpline request: same answer for known and unknown numbers, both recorded', async () => {
    const u = await c.signup();
    const known = await c.api().post('/v1/auth/reset-request', { mobile: u.mobile });
    const unknown = await c.api().post('/v1/auth/reset-request', { mobile: '9000011111' });
    expect(known.body).toEqual(unknown.body);
    const rows = await c.db.select().from(helplineRequests);
    expect(rows.find((r) => r.mobile === u.mobile)?.userId).toBe(u.id);
    expect(rows.find((r) => r.mobile === '9000011111')?.userId).toBeNull();
  });

  test('SCAN-17 the daily scan quest makes a gift affordable → "gift unlocked"', async () => {
    const owner = await c.ownerLogin();
    const u = await c.signup();
    await owner.post(`/v1/admin/applicators/${u.id}/adjust`, { wallet: 'runs', amount: 55, reason: 'test' });
    const { codes } = await c.makeCodes(owner, 1);
    const r = await u.api.post('/v1/coupons/redeem', { code: codes[0], source: 'scan' });
    // +10 runs from the "scan 1 coupon" quest: 55 → 65, the 60-run watch is now in reach.
    expect(r.body.balance.runs).toBe(65);
    expect(r.body.reward).toEqual({ kind: 'gift', gift: { id: 'watch', name: 'Smart watch' } });
  });

  test('WD-03 UPI registered to a different name than the PAN cannot be saved', async () => {
    const u = await c.signup({ name: 'Ram Kumar' });
    await u.api.post('/v1/me/kyc/pan', { pan: 'ABCDE1234F', name: 'Ram Kumar' });
    const check = await u.api.post('/v1/me/kyc/upi/check', { upiId: 'ram.other@ybl' });
    expect(check.body).toMatchObject({ name: 'SURESH KUMAR', matchesPan: false });
    const save = await u.api.put('/v1/me/kyc/upi', { upiId: 'ram.other@ybl' });
    expect(save.body.error.code).toBe('name_mismatch');
    // Name matching ignores case, order of extra words and punctuation.
    expect(namesMatch('RAM KUMAR', 'Ram  Kumar.')).toBe(true);
    expect(namesMatch('RAM KUMAR SHARMA', 'Ram Kumar')).toBe(true);
    expect(namesMatch('RAM KUMAR', 'SURESH KUMAR')).toBe(false);
  });

  test('ADM-10 full PAN: accounts can see it (audited), factory cannot', async () => {
    const owner = await c.ownerLogin();
    const u = await c.signup({ name: 'Pan Person' });
    await u.api.post('/v1/me/kyc/pan', { pan: 'PQRSX6789K', name: 'Pan Person' });
    // Stored encrypted — the database never holds the plain PAN.
    const raw = await c.db.execute(`select pan_enc, pan_masked from gomax.user_kyc where user_id = '${u.id}'` as never);
    const row = (raw as unknown as { rows: { pan_enc: string; pan_masked: string }[] }).rows[0];
    expect(row.pan_enc).not.toContain('PQRSX6789K');
    expect(row.pan_masked).toBe('PQRSX••••K');

    await owner.post('/v1/admin/staff', { loginId: 'acc1', name: 'Accounts', role: 'accounts', password: 'acc-pass-111', pin: '7777' });
    await owner.post('/v1/admin/staff', { loginId: 'fac1', name: 'Factory', role: 'factory', password: 'fac-pass-111', pin: '8888' });
    const login = async (id: string, pw: string, pin: string) => c.api((await c.api().post('/v1/admin/auth/login', { loginId: id, password: pw, pin })).body.accessToken);
    const acc = await login('acc1', 'acc-pass-111', '7777');
    const fac = await login('fac1', 'fac-pass-111', '8888');
    expect((await acc.get(`/v1/admin/applicators/${u.id}/pan`)).body).toEqual({ pan: 'PQRSX6789K', name: 'PAN PERSON' });
    expect((await fac.get(`/v1/admin/applicators/${u.id}/pan`)).status).toBe(403);
    const views = await c.db.select().from(auditLog).where(eq(auditLog.action, 'pan_view'));
    expect(views.some((v) => v.entityId === u.id)).toBe(true);
  });

  test('SEC-04 WhatsApp webhook: wrong signature refused, correct one accepted', async () => {
    const body = { entry: [{ changes: [{ value: { messages: [] } }] }] };
    const sig = `sha256=${createHmac('sha256', 'meta-app-secret').update(JSON.stringify(body)).digest('hex')}`;
    const bad = await c.app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: body, headers: { 'x-hub-signature-256': 'sha256=deadbeef' } });
    expect(bad.statusCode).toBe(403);
    const none = await c.app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: body });
    expect(none.statusCode).toBe(403);
    const good = await c.app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: body, headers: { 'x-hub-signature-256': sig } });
    expect(good.statusCode).toBe(200);
  });
});
