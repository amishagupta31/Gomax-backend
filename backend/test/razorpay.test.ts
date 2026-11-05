// RazorpayX payouts end to end, against a fake RazorpayX that answers like the
// real API (contacts, fund accounts, validations, payouts with idempotency
// keys). The real client code (src/lib/razorpay.ts) runs on top of it.
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { withdrawals } from '../src/db/schema.js';
import { loadConfig } from '../src/config.js';
import { razorpayKyc } from '../src/lib/kyc.js';
import { razorpayClient, type Payout } from '../src/lib/razorpay.js';
import { setup, type Ctx } from './helpers.js';
import { moneyInvariants } from './invariants.js';

const WEBHOOK_SECRET = 'whsec_test_123';

/** In-memory RazorpayX. */
function fakeRazorpayX() {
  const state = {
    contacts: [] as { id: string; name: string; contact: string }[],
    fundAccounts: [] as { id: string; contact_id: string; vpa: string }[],
    payouts: new Map<string, Payout & { fund_account_id: string; narration: string; idem: string }>(),
    byIdem: new Map<string, string>(),
    calls: [] as { method: string; path: string; headers: Record<string, string>; body: any }[],
    /** Fail the next N calls to this path with this HTTP status. */
    failNext: null as null | { path: string; status: number; times: number },
    /** Create the payout but lose the response (timeout after Razorpay acted). */
    loseNextPayoutResponse: false,
    upiNames: { 'ram@ybl': 'RAM KUMAR' } as Record<string, string>,
    inactiveUpis: new Set<string>(['closed@ybl']),
    seq: 0,
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace('/v1', '');
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push({ method, path, headers, body });
    if (!headers.authorization?.startsWith('Basic ')) return json(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'auth' } });
    if (state.failNext && path.startsWith(state.failNext.path) && state.failNext.times > 0) {
      state.failNext.times--;
      return json(state.failNext.status, { error: { code: 'SERVER_ERROR', description: 'Temporary problem' } });
    }
    const id = (p: string) => `${p}_${++state.seq}`;
    if (method === 'POST' && path === '/contacts') {
      const c = { id: id('cont'), name: body.name, contact: body.contact };
      state.contacts.push(c);
      return json(201, c);
    }
    if (method === 'POST' && path === '/fund_accounts') {
      const fa = { id: id('fa'), contact_id: body.contact_id, vpa: body.vpa.address };
      state.fundAccounts.push(fa);
      return json(201, fa);
    }
    if (method === 'POST' && path === '/fund_accounts/validations') {
      const fa = state.fundAccounts.find((f) => f.id === body.fund_account.id)!;
      const active = !state.inactiveUpis.has(fa.vpa);
      return json(201, { id: id('fav'), status: 'completed', results: { account_status: active ? 'active' : 'invalid', registered_name: active ? (state.upiNames[fa.vpa] ?? 'SOMEONE') : null } });
    }
    if (method === 'POST' && path === '/payouts') {
      const idem = headers['x-payout-idempotency'];
      if (!idem) return json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'idempotency key required' } });
      const existing = state.byIdem.get(idem);
      if (existing) return json(200, state.payouts.get(existing)); // same key → same payout, no second transfer
      const p = { id: id('pout'), status: 'processing' as const, amount: body.amount, utr: null, reference_id: body.reference_id, fund_account_id: body.fund_account_id, narration: body.narration, idem };
      state.payouts.set(p.id, p);
      state.byIdem.set(idem, p.id);
      if (state.loseNextPayoutResponse) {
        state.loseNextPayoutResponse = false;
        throw new TypeError('fetch failed: socket hang up');
      }
      return json(200, p);
    }
    const m = path.match(/^\/payouts\/(.+)$/);
    if (method === 'GET' && m) return state.payouts.has(m[1]) ? json(200, state.payouts.get(m[1])) : json(404, { error: { code: 'NOT_FOUND', description: 'no payout' } });
    return json(404, { error: { code: 'NOT_FOUND', description: path } });
  }) as typeof fetch;
  return { state, fetchImpl };
}

const fake = fakeRazorpayX();
const rzp = razorpayClient({ keyId: 'rzp_test_key', keySecret: 'secret', accountNumber: '2323230000000000' }, fake.fetchImpl);
let c: Ctx;
let owner: Awaited<ReturnType<Ctx['ownerLogin']>>;

beforeAll(async () => {
  c = await setup({
    razorpay: rzp,
    env: { PAYOUT_MODE: 'razorpayx', RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'secret', RAZORPAYX_ACCOUNT_NUMBER: '2323230000000000', RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET },
  });
  owner = await c.ownerLogin();
});
afterAll(async () => {
  await c.close();
});
afterEach(async () => {
  expect(await moneyInvariants(c.db)).toEqual([]);
});

/** A user with KYC + points, a withdrawal, approved by staff. Returns its id. */
async function approvedWithdrawal(amount = 1000, name = 'Ram Kumar') {
  const u = await c.signup({ name });
  await owner.post(`/v1/admin/applicators/${u.id}/adjust`, { wallet: 'points', amount: amount + 500, reason: 'test' });
  await c.kyc(u);
  const w = (await u.api.post('/v1/withdrawals', { amount })).body;
  expect((await owner.post(`/v1/admin/withdrawals/${w.id}/approve`, { pin: '1234' })).status).toBe(200);
  return { u, w, n: Number(w.id.slice(2)) };
}
const row = async (n: number) => (await c.db.select().from(withdrawals).where(eq(withdrawals.id, n)))[0];
const webhook = (payout: Partial<Payout> & { id: string; status: string }, secret = WEBHOOK_SECRET, event = `payout.${payout.status}`) => {
  const body = JSON.stringify({ entity: 'event', event, payload: { payout: { entity: { amount: 100000, utr: null, ...payout } } }, created_at: 1 });
  return c.app.inject({ method: 'POST', url: '/webhooks/razorpay', payload: body, headers: { 'content-type': 'application/json', 'x-razorpay-signature': createHmac('sha256', secret).update(body).digest('hex') } });
};

describe('RazorpayX payouts', () => {
  test('approve → job sends one payout: right amount, UPI, idempotency key and narration', async () => {
    const { w, n } = await approvedWithdrawal(1000);
    expect((await row(n)).payoutMode).toBe('razorpayx');
    const job = await c.runJob('payouts');
    expect(job.body).toMatchObject({ sent: 1, sendErrors: 0 });
    const r = await row(n);
    expect(r.payoutStatus).toBe('processing');
    const p = fake.state.payouts.get(r.payoutRef!)!;
    expect(p).toMatchObject({ amount: 100000, reference_id: w.id, narration: `GoMax W${n}`, idem: `gomax-W-${n}` });
    const fa = fake.state.fundAccounts.find((f) => f.id === p.fund_account_id)!;
    expect(fa.vpa).toBe('ram@ybl');
    // Running the job again never sends it twice.
    await c.runJob('payouts');
    expect([...fake.state.payouts.values()].filter((x) => x.reference_id === w.id)).toHaveLength(1);
  });

  test('webhook "processed" → Paid with the bank UTR, notification and WhatsApp; repeats change nothing', async () => {
    const { u, w, n } = await approvedWithdrawal(700, 'Paid Person');
    await c.runJob('payouts');
    const ref = (await row(n)).payoutRef!;
    expect((await webhook({ id: ref, status: 'processed', utr: '427188365520', reference_id: w.id })).statusCode).toBe(200);
    const mine = (await u.api.get(`/v1/withdrawals/${w.id}`)).body;
    expect(mine).toMatchObject({ status: 'paid', utr: '427188365520' });
    await c.runJob('outbox');
    const msg = c.wa.sent.find((m) => m.to === u.mobile && m.template === 'withdrawal_paid')!;
    expect(msg.vars).toMatchObject({ amount: '₹700', utr: '4271 8836 5520' });
    // Razorpay retries webhooks: a second delivery is a no-op.
    await webhook({ id: ref, status: 'processed', utr: '427188365520', reference_id: w.id });
    await c.runJob('outbox');
    expect(c.wa.sent.filter((m) => m.to === u.mobile && m.template === 'withdrawal_paid')).toHaveLength(1);
  });

  test('webhook with a wrong or missing signature is refused', async () => {
    const { n } = await approvedWithdrawal(600);
    await c.runJob('payouts');
    const ref = (await row(n)).payoutRef!;
    expect((await webhook({ id: ref, status: 'processed', utr: '111' }, 'not-the-secret')).statusCode).toBe(403);
    const raw = await c.app.inject({ method: 'POST', url: '/webhooks/razorpay', payload: { event: 'payout.processed', payload: { payout: { entity: { id: ref, status: 'processed' } } } } });
    expect(raw.statusCode).toBe(403);
    expect((await row(n)).status).toBe('approved');
  });

  test('payout failed / rejected → points returned once, WhatsApp "money not sent"', async () => {
    for (const status of ['failed', 'rejected'] as const) {
      const { u, w, n } = await approvedWithdrawal(800, `Fail ${status}`);
      const before = (await u.api.get('/v1/wallet')).body.points;
      await c.runJob('payouts');
      const ref = (await row(n)).payoutRef!;
      await webhook({ id: ref, status, reference_id: w.id, status_details: { description: 'Beneficiary bank is down', reason: 'bank_down' } });
      await webhook({ id: ref, status, reference_id: w.id }); // repeat
      expect((await u.api.get('/v1/wallet')).body.points).toBe(before + 800);
      expect((await u.api.get(`/v1/withdrawals/${w.id}`)).body).toMatchObject({ status: 'failed', reason: 'Beneficiary bank is down' });
    }
  });

  test('reversed after it was paid (money bounced back) → points returned', async () => {
    const { u, w, n } = await approvedWithdrawal(900, 'Reversed');
    await c.runJob('payouts');
    const ref = (await row(n)).payoutRef!;
    await webhook({ id: ref, status: 'processed', utr: '222233334444', reference_id: w.id });
    const before = (await u.api.get('/v1/wallet')).body.points;
    await webhook({ id: ref, status: 'reversed', reference_id: w.id });
    expect((await u.api.get('/v1/wallet')).body.points).toBe(before + 900);
    expect((await row(n)).status).toBe('failed');
  });

  test('Razorpay down when sending → stays approved with the error shown; the retry sends exactly one payout', async () => {
    const { w, n } = await approvedWithdrawal(650, 'Retry Me');
    fake.state.failNext = { path: '/payouts', status: 503, times: 1 };
    expect((await c.runJob('payouts')).body).toMatchObject({ sendErrors: 1 });
    const r = await row(n);
    expect(r).toMatchObject({ status: 'approved', payoutStatus: 'error', payoutRef: null });
    expect(r.payoutError).toContain('Temporary problem');
    const staffView = (await owner.get('/v1/admin/withdrawals?status=approved')).body.rows.find((x: { id: string }) => x.id === w.id);
    expect(staffView).toMatchObject({ payoutStatus: 'error', payoutMode: 'razorpayx' });
    await c.runJob('payouts');
    expect((await row(n)).payoutStatus).toBe('processing');
    expect([...fake.state.payouts.values()].filter((x) => x.reference_id === w.id)).toHaveLength(1);
  });

  test('Razorpay paid but the reply was lost (timeout) → the retry gets the same payout, never a second one', async () => {
    const { w, n } = await approvedWithdrawal(750, 'Lost Reply');
    fake.state.loseNextPayoutResponse = true;
    await c.runJob('payouts');
    expect((await row(n)).payoutStatus).toBe('error');
    await c.runJob('payouts');
    expect([...fake.state.payouts.values()].filter((x) => x.reference_id === w.id)).toHaveLength(1);
    expect((await row(n)).payoutRef).toBe([...fake.state.payouts.values()].find((x) => x.reference_id === w.id)!.id);
  });

  test('a missed webhook is caught by the sync 30 minutes later', async () => {
    const { u, w, n } = await approvedWithdrawal(550, 'Missed Hook');
    await c.runJob('payouts');
    const p = fake.state.payouts.get((await row(n)).payoutRef!)!;
    p.status = 'processed' as never;
    p.utr = '555566667777';
    c.clock.advance(31 * 60_000);
    await c.runJob('payouts');
    expect((await u.api.get(`/v1/withdrawals/${w.id}`)).body).toMatchObject({ status: 'paid', utr: '555566667777' });
    c.clock.advance(-31 * 60_000);
  });

  test('manual steps are blocked once RazorpayX handles it', async () => {
    const { w } = await approvedWithdrawal(600, 'No Manual');
    const proof = (await owner.post('/v1/admin/uploads', { purpose: 'payment_proof', contentType: 'image/jpeg' })).body.object;
    expect((await owner.post(`/v1/admin/withdrawals/${w.id}/lock`)).body.error.code).toBe('auto_payout');
    expect((await owner.post(`/v1/admin/withdrawals/${w.id}/mark-paid`, { utr: '123412341234', proofObject: proof })).body.error.code).toBe('auto_payout');
    await c.runJob('payouts');
    for (const action of ['fail', 'send-back', 'reject']) {
      expect((await owner.post(`/v1/admin/withdrawals/${w.id}/${action}`, { reason: 'changed my mind' })).body.error.code).toBe('sent_to_razorpay');
    }
  });

  test('the same person withdrawing again reuses their Razorpay contact and UPI account', async () => {
    const contactsBefore = fake.state.contacts.length;
    const { u, n } = await approvedWithdrawal(500, 'Repeat Payee');
    await c.runJob('payouts');
    const w2 = (await u.api.post('/v1/withdrawals', { amount: 500 })).body;
    await owner.post(`/v1/admin/withdrawals/${w2.id}/approve`, { pin: '1234' });
    await c.runJob('payouts');
    expect(fake.state.contacts.length - contactsBefore).toBe(1);
    const p1 = fake.state.payouts.get((await row(n)).payoutRef!)!;
    const p2 = fake.state.payouts.get((await row(Number(w2.id.slice(2)))).payoutRef!)!;
    expect(p2.fund_account_id).toBe(p1.fund_account_id);
  });

  test('every Razorpay call uses Basic auth with the key id', async () => {
    const auth = `Basic ${Buffer.from('rzp_test_key:secret').toString('base64')}`;
    expect(fake.state.calls.length).toBeGreaterThan(0);
    expect(fake.state.calls.every((x) => x.headers.authorization === auth)).toBe(true);
  });
});

describe('Razorpay configuration', () => {
  test('switching Razorpay on without the keys stops the server from starting', () => {
    const base = { NODE_ENV: 'test', DATABASE_URL: 'pglite://x', JWT_SECRET: 'x'.repeat(40), PAN_KEY: Buffer.alloc(32).toString('base64') };
    expect(() => loadConfig({ ...base, PAYOUT_MODE: 'razorpayx' })).toThrow(/RAZORPAY_KEY_ID.*RAZORPAY_KEY_SECRET.*RAZORPAYX_ACCOUNT_NUMBER.*RAZORPAY_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...base, KYC_DRIVER: 'razorpay' })).toThrow(/RAZORPAY_KEY_ID/);
    expect(() => loadConfig({ ...base })).not.toThrow(); // manual mode needs nothing
  });

  test('UPI name check through RazorpayX: returns the registered name; closed UPI refused', async () => {
    const kyc = razorpayKyc(rzp);
    expect(await kyc.lookupUpi('ram@ybl')).toEqual({ ok: true, name: 'RAM KUMAR' });
    expect(await kyc.lookupUpi('closed@ybl')).toEqual({ ok: false, error: 'This UPI ID is not active' });
    expect(await kyc.lookupUpi('not a upi')).toEqual({ ok: false, error: 'Check the UPI ID' });
  });
});
