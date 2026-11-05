import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { setup, type Ctx } from './helpers.js';

let c: Ctx;
beforeAll(async () => {
  c = await setup();
});
afterAll(async () => {
  await c.close();
});

/** Gives a user points via an owner adjustment. */
const give = async (owner: Awaited<ReturnType<Ctx['ownerLogin']>>, userId: string, wallet: 'points' | 'runs', amount: number) => {
  const r = await owner.post(`/v1/admin/applicators/${userId}/adjust`, { wallet, amount, reason: 'test credit' });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
};

/** Admin upload of a payment screenshot; returns the object name. */
const proof = async (owner: Awaited<ReturnType<Ctx['ownerLogin']>>) => (await owner.post('/v1/admin/uploads', { purpose: 'payment_proof', contentType: 'image/jpeg' })).body.object as string;

describe('B3 / D4 / D11 withdrawals', () => {
  test('needs PAN + UPI, min 500, max 5,000 a request', async () => {
    const owner = await c.ownerLogin();
    const u = await c.signup({ name: 'Ram Kumar' });
    await give(owner, u.id, 'points', 6000);
    expect((await u.api.post('/v1/withdrawals', { amount: 500 })).body.error.code).toBe('kyc_missing');

    // UPI name must match PAN.
    expect((await u.api.put('/v1/me/kyc/upi', { upiId: 'ram@ybl' })).body.error.code).toBe('pan_first');
    await c.kyc(u);
    expect((await u.api.post('/v1/withdrawals', { amount: 499 })).body.error.code).toBe('below_min');
    expect((await u.api.post('/v1/withdrawals', { amount: 5001 })).body.error.code).toBe('above_max');
    const w = await u.api.post('/v1/withdrawals', { amount: 1000 });
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ status: 'requested', upiId: 'ram@ybl', upiName: 'RAM KUMAR' });
    expect((await u.api.get('/v1/wallet')).body.points).toBe(5000);
  });

  test('₹15,000 a month limit (IST month)', async () => {
    const owner = await c.ownerLogin();
    const u = await c.signup({ name: 'Monthly Limit' });
    await give(owner, u.id, 'points', 10000);
    await give(owner, u.id, 'points', 10000);
    await c.kyc(u);
    for (let i = 0; i < 3; i++) expect((await u.api.post('/v1/withdrawals', { amount: 5000 })).status).toBe(200);
    const over = await u.api.post('/v1/withdrawals', { amount: 500 });
    expect(over.body.error.code).toBe('month_limit');
    expect(over.body.error.leftThisMonth).toBe(0);
  });

  test('approve needs PIN → lock → mark paid with unique UTR + proof → WhatsApp', async () => {
    const owner = await c.ownerLogin();
    const u = await c.signup({ name: 'Paid Person' });
    await give(owner, u.id, 'points', 3000);
    await c.kyc(u);
    const w = (await u.api.post('/v1/withdrawals', { amount: 1000 })).body;

    expect((await owner.post(`/v1/admin/withdrawals/${w.id}/approve`, { pin: '9999' })).body.error.message).toBe('Wrong PIN');
    expect((await owner.post(`/v1/admin/withdrawals/${w.id}/mark-paid`, { utr: '427188365520', proofObject: await proof(owner) })).body.error.code).toBe('bad_status');
    expect((await owner.post(`/v1/admin/withdrawals/${w.id}/approve`, { pin: '1234' })).status).toBe(200);

    const queue = await owner.get('/v1/admin/withdrawals?status=approved');
    const row = queue.body.rows.find((r: { id: string }) => r.id === w.id);
    expect(row.upiIntent).toContain('upi://pay?pa=ram%40ybl');

    expect((await owner.post(`/v1/admin/withdrawals/${w.id}/lock`)).status).toBe(200);
    expect((await owner.post(`/v1/admin/withdrawals/${w.id}/mark-paid`, { utr: '427188365520', proofObject: 'payment_proof/nope.jpg' })).body.error.code).toBe('proof_missing');
    const paid = await owner.post(`/v1/admin/withdrawals/${w.id}/mark-paid`, { utr: '427188365520', proofObject: await proof(owner) });
    expect(paid.status).toBe(200);

    const mine = await u.api.get(`/v1/withdrawals/${w.id}`);
    expect(mine.body).toMatchObject({ status: 'paid', utr: '427188365520' });
    expect(mine.body.proofUrl).toBeTruthy();

    // UTR can't be reused on another payout.
    const w2 = (await u.api.post('/v1/withdrawals', { amount: 1000 })).body;
    await owner.post(`/v1/admin/withdrawals/${w2.id}/approve`, { pin: '1234' });
    expect((await owner.post(`/v1/admin/withdrawals/${w2.id}/mark-paid`, { utr: '427188365520', proofObject: await proof(owner) })).body.error.code).toBe('utr_used');

    await c.runJob('outbox');
    const msgs = c.wa.sent.filter((m) => m.to === u.mobile).map((m) => m.template);
    expect(msgs).toEqual(expect.arrayContaining(['withdrawal_approved', 'withdrawal_paid']));
    const audit = await owner.get(`/v1/admin/audit?entity=withdrawal&entityId=${w.id.slice(2)}`);
    expect(audit.body.rows.map((r: { action: string }) => r.action)).toEqual(['withdrawal_paid', 'withdrawal_approve']);
  });

  test('reject and fail return the points', async () => {
    const owner = await c.ownerLogin();
    const u = await c.signup({ name: 'Refund Me' });
    await give(owner, u.id, 'points', 2000);
    await c.kyc(u);
    const a = (await u.api.post('/v1/withdrawals', { amount: 500 })).body;
    const b = (await u.api.post('/v1/withdrawals', { amount: 700 })).body;
    expect((await u.api.get('/v1/wallet')).body.points).toBe(800);
    await owner.post(`/v1/admin/withdrawals/${a.id}/reject`, { reason: 'UPI name does not match your PAN name.' });
    await owner.post(`/v1/admin/withdrawals/${b.id}/approve`, { pin: '1234' });
    await owner.post(`/v1/admin/withdrawals/${b.id}/fail`, { reason: 'UPI ID closed' });
    expect((await u.api.get('/v1/wallet')).body.points).toBe(2000);
    expect((await u.api.get(`/v1/withdrawals/${a.id}`)).body).toMatchObject({ status: 'rejected', reason: 'UPI name does not match your PAN name.' });
  });

  test('accounts staff can pay; factory staff cannot', async () => {
    const owner = await c.ownerLogin();
    await owner.post('/v1/admin/staff', { loginId: 'ankit', name: 'Ankit', role: 'accounts', password: 'ankit-pass-1', pin: '1111' });
    await owner.post('/v1/admin/staff', { loginId: 'shivansh', name: 'Shivansh', role: 'factory', password: 'shiv-pass-11', pin: '2222' });
    const login = async (loginId: string, password: string, pin: string) => c.api((await c.api().post('/v1/admin/auth/login', { loginId, password, pin })).body.accessToken);
    const ankit = await login('ankit', 'ankit-pass-1', '1111');
    const shiv = await login('shivansh', 'shiv-pass-11', '2222');
    expect((await ankit.get('/v1/admin/withdrawals')).status).toBe(200);
    expect((await shiv.get('/v1/admin/withdrawals')).status).toBe(403);
    expect((await shiv.get('/v1/admin/gift-orders')).status).toBe(200);
    expect((await ankit.put('/v1/admin/settings/withdraw', { value: { minPoints: 100, maxPerRequest: 5000, maxPerMonth: 15000 } })).status).toBe(403);
  });
});

describe('B2 / D5 gifts', () => {
  test('book with runs → pack → ship → deliver; cancel refunds', async () => {
    const owner = await c.ownerLogin();
    const u = await c.signup({ name: 'Gift Person' });
    const address = { name: 'Gift Person', mobile: '9876543210', street: 'H.No 214, Gali 3, Gandhi Nagar', city: 'Amritsar', pin: '143001' };
    expect((await u.api.post('/v1/gift-orders', { giftId: 'watch', address })).body.error.code).toBe('insufficient_balance');
    await give(owner, u.id, 'runs', 200);
    expect((await u.api.post('/v1/gift-orders', { giftId: 'tshirt', address })).body.error.code).toBe('size_required');
    const o = (await u.api.post('/v1/gift-orders', { giftId: 'watch', address })).body;
    expect(o).toMatchObject({ step: 'booked', runs: 60 });
    expect((await u.api.get('/v1/wallet')).body.runs).toBe(140);

    await owner.post(`/v1/admin/gift-orders/${o.id}/pack`);
    await owner.post(`/v1/admin/gift-orders/${o.id}/ship`, { courierName: 'DTDC', awb: '7X2938475' });
    const photo = (await owner.post('/v1/admin/uploads', { purpose: 'delivery_photo', contentType: 'image/jpeg' })).body.object;
    expect((await owner.post(`/v1/admin/gift-orders/${o.id}/deliver`, { photoObject: photo, receivedBy: 'Ram' })).status).toBe(200);
    const mine = await u.api.get(`/v1/gift-orders/${o.id}`);
    expect(mine.body).toMatchObject({ step: 'delivered', receivedBy: 'Ram', courier: { awb: '7X2938475' } });
    expect(mine.body.deliveryPhotoUrl).toBeTruthy();

    const o2 = (await u.api.post('/v1/gift-orders', { giftId: 'watch', address })).body;
    await owner.post(`/v1/admin/gift-orders/${o2.id}/cancel`, { reason: 'Out of stock at vendor' });
    expect((await u.api.get('/v1/wallet')).body.runs).toBe(140);

    await c.runJob('outbox');
    expect(c.wa.sent.filter((m) => m.to === u.mobile).map((m) => m.template)).toEqual(expect.arrayContaining(['gift_packed', 'gift_shipped', 'gift_delivered']));
  });

  test('stock runs out', async () => {
    const owner = await c.ownerLogin();
    await owner.post('/v1/admin/gifts', { id: 'cap', name: 'GoMax cap', runsPrice: 10, stock: 1 });
    const [a, b] = [await c.signup(), await c.signup()];
    await give(owner, a.id, 'runs', 10);
    await give(owner, b.id, 'runs', 10);
    const address = { name: 'A B', mobile: '9876543210', street: 'Street 12345', city: 'Amritsar', pin: '143001' };
    expect((await a.api.post('/v1/gift-orders', { giftId: 'cap', address })).status).toBe(200);
    expect((await b.api.post('/v1/gift-orders', { giftId: 'cap', address })).body.error.code).toBe('out_of_stock');
  });
});
