// Admin APIs added for the website's "Not connected yet" parts: dashboard
// insights, applicator KYC filters + helpline tools, Mark KYC ok, referral
// overview, dealers (D10), home content (D8a), print PDF (D2d) and the
// Accounts view of the audit log.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, dealers, helplineRequests, users, waOutbox } from '../src/db/schema.js';
import { mockKyc, type KycProvider } from '../src/lib/kyc.js';
import { setup, type Ctx } from './helpers.js';

// "shop@ybl" is registered to a shop name, so the app refuses it for "Raju Sharma".
const kyc: KycProvider = {
  verifyPan: mockKyc().verifyPan,
  async lookupUpi(upi) {
    if (upi === 'shop@ybl') return { ok: true, name: 'SHARMA TILES' };
    if (upi === 'gone@ybl') return { ok: false, error: 'This UPI ID is not active' };
    return mockKyc().lookupUpi(upi);
  },
};

let c: Ctx;
let owner: Awaited<ReturnType<Ctx['ownerLogin']>>;
type Api = ReturnType<Ctx['api']>;
const staff: Record<string, Api> = {};

beforeAll(async () => {
  c = await setup({ kyc });
  owner = await c.ownerLogin();
  for (const [role, pin] of [
    ['accounts', '1111'],
    ['factory', '2222'],
    ['helpline', '3333'],
    ['ops', '4444'],
  ] as const) {
    await owner.post('/v1/admin/staff', { loginId: `t-${role}`, name: `Test ${role}`, role, password: `${role}-pass-1234`, pin });
    const r = await c.api().post('/v1/admin/auth/login', { loginId: `t-${role}`, password: `${role}-pass-1234`, pin });
    staff[role] = c.api(r.body.accessToken);
  }
});
afterAll(async () => {
  await c.close();
});

describe('dashboard insights (D1)', () => {
  test('14-day chart, active in 30 days, top applicators this month', async () => {
    const owner2 = owner;
    const { codes } = await c.makeCodes(owner2, 5, 20);
    const a = await c.signup({ name: 'Top Scanner' });
    const b = await c.signup({ name: 'Second Scanner' });
    for (const code of codes.slice(0, 3)) await a.api.post('/v1/coupons/redeem', { code, source: 'scan' });
    await b.api.post('/v1/coupons/redeem', { code: codes[3], source: 'scan' });
    const r = await owner.get('/v1/admin/dashboard/insights');
    expect(r.status).toBe(200);
    expect(r.body.daily).toHaveLength(14);
    const today = r.body.daily.at(-1);
    expect(today.coupons).toBeGreaterThanOrEqual(4);
    expect(today.points).toBeGreaterThanOrEqual(80);
    expect(r.body.activeApplicators30d).toBeGreaterThanOrEqual(2);
    expect(r.body.registered).toBeGreaterThanOrEqual(2);
    expect(r.body.topApplicators[0]).toMatchObject({ name: 'Top Scanner', coupons: 3 });
    expect((await owner.get('/v1/admin/dashboard/insights?days=30')).body.daily).toHaveLength(30);
    expect((await staff.factory!.get('/v1/admin/dashboard/insights')).status).toBe(403);
  });
});

describe('applicators: KYC filters and helpline tools (D9b, M5)', () => {
  test('list shows PAN / UPI state and filters: KYC to check, no PAN, blocked, cash on hold', async () => {
    const none = await c.signup({ name: 'No Pan Yet' });
    const stuck = await c.signup({ name: 'Raju Sharma' });
    await stuck.api.post('/v1/me/kyc/pan', { pan: 'ABCDE1234F', name: 'Raju Sharma' });
    expect((await stuck.api.put('/v1/me/kyc/upi', { upiId: 'shop@ybl' })).body.error.code).toBe('name_mismatch');
    const done = await c.signup({ name: 'Ram Kumar' });
    await c.kyc(done);

    const all = (await owner.get('/v1/admin/applicators?limit=100')).body.rows as { id: string; panAdded: boolean; upiAdded: boolean }[];
    expect(all.find((r) => r.id === none.id)).toMatchObject({ panAdded: false, upiAdded: false });
    expect(all.find((r) => r.id === done.id)).toMatchObject({ panAdded: true, upiAdded: true });

    const ids = async (view: string) => ((await owner.get(`/v1/admin/applicators?limit=100&view=${view}`)).body.rows as { id: string }[]).map((r) => r.id);
    expect(await ids('kyc')).toContain(stuck.id);
    expect(await ids('kyc')).not.toContain(done.id);
    expect(await ids('no_pan')).toContain(none.id);
    expect(await ids('no_pan')).not.toContain(stuck.id);
    await owner.post(`/v1/admin/applicators/${none.id}/block`, { blocked: true, reason: 'test block' });
    await owner.post(`/v1/admin/applicators/${done.id}/hold`, { hold: true, reason: 'test hold' });
    expect(await ids('blocked')).toEqual([none.id]);
    expect(await ids('hold')).toContain(done.id);
    expect(await ids('active')).not.toContain(none.id);
  });

  test('Mark KYC ok: accounts saves the UPI after checking the name by hand; audited', async () => {
    const u = await c.signup({ name: 'Raju Sharma' });
    // Before PAN: refused.
    expect((await staff.accounts!.post(`/v1/admin/applicators/${u.id}/kyc-ok`, { upiId: 'shop@ybl', note: 'checked on call' })).body.error.code).toBe('pan_first');
    await u.api.post('/v1/me/kyc/pan', { pan: 'ABCDE1234F', name: 'Raju Sharma' });
    expect((await staff.accounts!.post(`/v1/admin/applicators/${u.id}/kyc-ok`, { upiId: 'gone@ybl', note: 'checked on call' })).body.error.code).toBe('upi_not_found');
    expect((await staff.helpline!.post(`/v1/admin/applicators/${u.id}/kyc-ok`, { upiId: 'shop@ybl', note: 'x x x' })).status).toBe(403);
    const r = await staff.accounts!.post(`/v1/admin/applicators/${u.id}/kyc-ok`, { upiId: 'shop@ybl', note: 'His own shop, checked GST' });
    expect(r.body).toEqual({ ok: true, upi: { id: 'shop@ybl', name: 'SHARMA TILES' } });
    const p = (await owner.get(`/v1/admin/applicators/${u.id}`)).body;
    expect(p.kyc.upi).toMatchObject({ id: 'shop@ybl', matchesPan: true });
    const [a] = await c.db.select().from(auditLog).where(eq(auditLog.action, 'kyc_ok'));
    expect(a.after).toMatchObject({ upiName: 'SHARMA TILES', panName: 'RAJU SHARMA', note: 'His own shop, checked GST' });
  });

  test('helpline: reset password sends a one-time WhatsApp link; unlock clears a paused login', async () => {
    const u = await c.signup({ name: 'Forgot Pass' });
    const before = (await c.db.select().from(waOutbox)).length;
    expect((await staff.helpline!.post(`/v1/admin/applicators/${u.id}/reset-password`)).body).toEqual({ ok: true, channel: 'whatsapp' });
    const out = await c.db.select().from(waOutbox);
    expect(out.length).toBe(before + 1);
    expect(out.at(-1)).toMatchObject({ template: 'password_reset' });
    expect((await staff.factory!.post(`/v1/admin/applicators/${u.id}/reset-password`)).status).toBe(403);

    for (let i = 0; i < 6; i++) await c.api().post('/v1/auth/login', { mobile: u.mobile, password: 'wrong-pass-1' });
    expect((await c.api().post('/v1/auth/login', { mobile: u.mobile, password: 'secret123' })).status).toBe(423);
    expect((await staff.helpline!.post(`/v1/admin/applicators/${u.id}/unlock`)).body).toEqual({ ok: true });
    expect((await c.api().post('/v1/auth/login', { mobile: u.mobile, password: 'secret123' })).status).toBe(200);
  });

  test('helpline call-back requests: list open ones, mark done', async () => {
    await c.api().post('/v1/auth/reset-request', { mobile: '9812345678' });
    const open = (await staff.helpline!.get('/v1/admin/helpline-requests')).body.rows;
    const r = open.find((x: { mobile: string }) => x.mobile === '9812345678');
    expect(r).toBeTruthy();
    expect((await staff.helpline!.post(`/v1/admin/helpline-requests/${r.id}/done`)).body).toEqual({ ok: true });
    expect((await staff.helpline!.post(`/v1/admin/helpline-requests/${r.id}/done`)).status).toBe(404);
    const [row] = await c.db.select().from(helplineRequests).where(eq(helplineRequests.id, r.id));
    expect(row.status).toBe('done');
    expect((await staff.accounts!.get('/v1/admin/helpline-requests')).status).toBe(403);
  });
});

describe('referral overview (D6b)', () => {
  test('top referrers: people who joined, runs earned, runs this month vs cap', async () => {
    const inviter = await c.signup({ name: 'Big Inviter' });
    const [{ code }] = await c.db.select({ code: users.inviteCode }).from(users).where(eq(users.id, inviter.id));
    const f1 = await c.signup({ name: 'Friend One', referralCode: code });
    await c.signup({ name: 'Friend Two', referralCode: code });
    const { codes } = await c.makeCodes(owner, 1, 20);
    await f1.api.post('/v1/coupons/redeem', { code: codes[0], source: 'scan' });
    const r = await staff.helpline!.get('/v1/admin/referrals/top');
    expect(r.body.monthlyCapRuns).toBeGreaterThan(0);
    const row = r.body.rows.find((x: { id: string }) => x.id === inviter.id);
    expect(row).toMatchObject({ joined: 2, joinedScanning: 1 });
    expect(row.runsEarned).toBeGreaterThan(0);
    expect(row.runsThisMonth).toBe(row.runsEarned);
    expect((await staff.factory!.get('/v1/admin/referrals/top')).status).toBe(403);
  });
});

describe('dealers (D10)', () => {
  test('owner creates a login GMD-<area>-<no> with a temporary password shown once', async () => {
    const r = await owner.post('/v1/admin/dealers', { firm: 'Sharma Tiles & Sanitary', ownerName: 'Rajesh Sharma', mobile: '9814055210', gst: '03ABCDE1234F1Z5', area: 'ldh' });
    expect(r.status).toBe(200);
    expect(r.body.dealer).toMatchObject({ loginId: 'GMD-LDH-0001', area: 'LDH', active: true, mustChangePassword: true });
    expect(r.body.tempPassword).toMatch(/^[A-Za-z2-9]{10}$/);
    const [row] = await c.db.select().from(dealers).where(eq(dealers.id, r.body.dealer.id));
    expect(row.passwordHash).not.toContain(r.body.tempPassword);
    expect(new Date(row.tempPasswordExpiresAt!).getTime() - c.clock.now().getTime()).toBe(7 * 86_400_000);
    const second = await owner.post('/v1/admin/dealers', { firm: 'Gill Hardware', ownerName: 'Harpreet Gill', mobile: '9876500011', area: 'LDH' });
    expect(second.body.dealer.loginId).toBe('GMD-LDH-0002');
    expect((await owner.get('/v1/admin/dealers?q=gill')).body.rows).toHaveLength(1);
    expect((await owner.get('/v1/admin/dealers?area=LDH')).body.rows).toHaveLength(2);
  });

  test('bad GST / mobile / area refused; only owners create', async () => {
    expect((await owner.post('/v1/admin/dealers', { firm: 'X Tiles', ownerName: 'X Y', mobile: '9814055210', gst: '12345', area: 'LDH' })).status).toBe(400);
    expect((await owner.post('/v1/admin/dealers', { firm: 'X Tiles', ownerName: 'X Y', mobile: '12345', area: 'LDH' })).status).toBe(400);
    expect((await owner.post('/v1/admin/dealers', { firm: 'X Tiles', ownerName: 'X Y', mobile: '9814055210', area: 'L1' })).status).toBe(400);
    expect((await staff.helpline!.post('/v1/admin/dealers', { firm: 'X Tiles', ownerName: 'X Y', mobile: '9814055210', area: 'LDH' })).status).toBe(403);
  });

  test('reset password (owner or helpline) gives a new temporary password; deactivate keeps data and can be undone', async () => {
    const d = (await owner.post('/v1/admin/dealers', { firm: 'Patiala Ceramics', ownerName: 'Aman Singh', mobile: '9876500022', area: 'PTA' })).body;
    const [before] = await c.db.select().from(dealers).where(eq(dealers.id, d.dealer.id));
    const reset = await staff.helpline!.post(`/v1/admin/dealers/${d.dealer.id}/reset-password`);
    expect(reset.body.tempPassword).not.toBe(d.tempPassword);
    const [after] = await c.db.select().from(dealers).where(eq(dealers.id, d.dealer.id));
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect((await staff.helpline!.post(`/v1/admin/dealers/${d.dealer.id}/deactivate`, { reason: 'Shop closed' })).status).toBe(403);
    expect((await owner.post(`/v1/admin/dealers/${d.dealer.id}/deactivate`, { reason: 'Shop closed' })).body).toMatchObject({ active: false, deactivatedReason: 'Shop closed' });
    expect((await staff.helpline!.post(`/v1/admin/dealers/${d.dealer.id}/reset-password`)).status).toBe(404);
    expect((await owner.post(`/v1/admin/dealers/${d.dealer.id}/reactivate`)).body).toMatchObject({ active: true, deactivatedReason: null });
    const actions = (await c.db.select().from(auditLog).where(eq(auditLog.entityId, d.dealer.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['dealer_create', 'dealer_reset_password', 'dealer_deactivate', 'dealer_reactivate']));
  });
});

describe('home content (D8a)', () => {
  test('owner adds cards in 3 languages; the app gets live cards in its language (English fallback)', async () => {
    const live = await owner.post('/v1/admin/content/cards', { title: { en: 'Scan every bag', hi: 'हर बैग स्कैन करें' }, body: { en: 'Each coupon = points', hi: 'हर कूपन = पॉइंट' }, art: 'qr', sort: 1 });
    expect(live.status).toBe(200);
    await owner.post('/v1/admin/content/cards', { title: { en: 'Old offer' }, body: { en: 'gone' }, active: false });
    expect((await owner.post('/v1/admin/content/cards', { title: { en: 'Diwali' }, body: { en: 'x' }, rule: 'date_range' })).body.error.code).toBe('dates_required');
    await owner.put('/v1/admin/content/pages/terms', { body: { en: 'Each code works once.', pa: 'ਹਰ ਕੋਡ ਇੱਕ ਵਾਰ' } });

    const u = await c.signup({ name: 'Content Reader' }); // language defaults to Hindi
    const r = await u.api.get('/v1/content');
    expect(r.body.cards.map((x: { title: string }) => x.title)).toEqual(['हर बैग स्कैन करें']);
    expect(r.body.pages.terms).toBe('Each code works once.'); // no Hindi → English

    await owner.patch(`/v1/admin/content/cards/${live.body.id}`, { active: false });
    expect((await u.api.get('/v1/content')).body.cards).toHaveLength(0);
    expect((await staff.helpline!.patch(`/v1/admin/content/cards/${live.body.id}`, { active: true })).status).toBe(403);
    expect((await staff.helpline!.get('/v1/admin/content')).body.cards.length).toBeGreaterThanOrEqual(2);
  });
});

describe('coupon print PDF + area (D2b, D2d)', () => {
  test('48 per A4, factory can download, logged; helpline cannot', async () => {
    const b = (await owner.post('/v1/admin/coupon-batches', { valuePoints: 20, quantity: 50, area: 'Punjab · Ludhiana' })).body;
    expect(b.area).toBe('Punjab · Ludhiana');
    const res = await c.app.inject({ method: 'GET', url: `/v1/admin/coupon-batches/${b.id}/print.pdf`, headers: { authorization: `Bearer ${await tokenOf('factory')}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.rawPayload.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(2); // 50 coupons = 2 pages
    const logs = await c.db.select().from(auditLog).where(eq(auditLog.action, 'export_batch_pdf'));
    expect(logs.at(-1)).toMatchObject({ entityId: String(b.id), after: { pages: 2 } });
    expect((await staff.helpline!.get(`/v1/admin/coupon-batches/${b.id}/print.pdf`)).status).toBe(403);
  });
});

describe('audit log: Accounts see money rows only (D9d)', () => {
  test('owner sees all, accounts see withdrawals + balance changes, helpline none', async () => {
    const all = (await owner.get('/v1/admin/audit?limit=100')).body.rows as { entity: string; action: string }[];
    expect(all.some((r) => r.entity === 'dealer')).toBe(true);
    const acc = (await staff.accounts!.get('/v1/admin/audit?limit=100')).body.rows as { entity: string; action: string }[];
    expect(acc.length).toBeGreaterThan(0);
    expect(acc.every((r) => r.entity === 'withdrawal' || ['adjust_balance', 'kyc_ok', 'pan_view'].includes(r.action))).toBe(true);
    expect((await staff.helpline!.get('/v1/admin/audit')).status).toBe(403);
  });
});

const tokens: Record<string, string> = {};
async function tokenOf(role: string) {
  const pins: Record<string, string> = { accounts: '1111', factory: '2222', helpline: '3333', ops: '4444' };
  tokens[role] ??= (await c.api().post('/v1/admin/auth/login', { loginId: `t-${role}`, password: `${role}-pass-1234`, pin: pins[role] })).body.accessToken;
  return tokens[role]!;
}
