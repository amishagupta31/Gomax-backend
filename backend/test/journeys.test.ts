// Real-user journeys: one person (or staff member) through several days of
// normal use, checking what they would see at each step. The clock is moved
// explicitly; every journey sets its own start time.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { setup, type Ctx } from './helpers.js';
import { moneyInvariants } from './invariants.js';

let c: Ctx;
beforeAll(async () => {
  c = await setup();
});
afterAll(async () => {
  await c.close();
});
afterEach(async () => {
  expect(await moneyInvariants(c.db)).toEqual([]);
});

const IST = (iso: string) => new Date(`${iso}+05:30`); // e.g. IST('2026-10-12T10:30:00')
const address = { name: 'Ramesh Kumar', mobile: '9876500001', street: 'H.No 214, Gali 3, Gandhi Nagar', city: 'Amritsar', pin: '143001' };
const staffLogin = async (loginId: string, password: string, pin: string) => {
  const r = await c.api().post('/v1/admin/auth/login', { loginId, password, pin });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return c.api(r.body.accessToken);
};
const photo = async (u: { api: ReturnType<Ctx['api']> }) => {
  const up = await u.api.post('/v1/uploads', { purpose: 'streak', contentType: 'image/jpeg' });
  return u.api.post('/v1/streak/photo', { object: up.body.object, takenAt: c.clock.now().toISOString(), lat: 31.63, lng: 74.87 });
};

describe('Ramesh — from sign-up to his first ₹500 in the bank', () => {
  test('a week of real use', async () => {
    c.clock.set(IST('2026-10-12T09:00:00')); // Monday morning
    const owner = await c.ownerLogin();
    await owner.post('/v1/admin/staff', { loginId: 'ankit', name: 'Ankit', role: 'accounts', password: 'ankit-pass-1', pin: '1111' });
    const { codes } = await c.makeCodes(owner, 40, 20);

    // Suresh is already on GoMax and shares his code on WhatsApp.
    const suresh = await c.signup({ name: 'Suresh Singh' });

    // Day 1 — Ramesh signs up with Suresh's code (A1-07), sees "Referred by Suresh".
    expect((await c.api().get(`/v1/auth/referral/${suresh.inviteCode}`)).body.name).toBe('Suresh Singh');
    const ramesh = await c.signup({ name: 'Ramesh Kumar', referralCode: suresh.inviteCode });
    let home = (await ramesh.api.get('/v1/home')).body;
    expect(home).toMatchObject({ points: 0, runs: 0, firstCouponDone: false, rank: { id: 'naya-saathi' }, spins: { left: 3 } });

    // First coupon: 20 points + 25 welcome bonus (A3-04). Suresh gets +50 runs.
    const first = await ramesh.api.post('/v1/coupons/redeem', { code: codes[0], source: 'scan', lat: 31.63, lng: 74.87, deviceId: 'ramesh-phone' });
    expect(first.body).toMatchObject({ kind: 'added', value: 20, bonus: 25 });
    expect((await suresh.api.get('/v1/notifications')).body.rows[0].title).toBe('Friend joined!');

    // He spins all 3 free spins and uploads his first work photo.
    for (let i = 0; i < 3; i++) expect((await ramesh.api.post('/v1/spins')).status).toBe(200);
    expect((await ramesh.api.post('/v1/spins')).body.error.code).toBe('no_spins_left');
    expect((await photo(ramesh)).body.completed).toBe(1);

    // 9 pm: one WhatsApp summary of the day, not one per scan.
    c.clock.set(IST('2026-10-12T21:00:00'));
    await c.runJob('daily-summary');
    await c.runJob('outbox');
    const toRamesh = c.wa.sent.filter((m) => m.to === ramesh.mobile).map((m) => m.template);
    expect(toRamesh).toEqual(['welcome', 'daily_summary']);

    // Days 2–5: 8 coupons and a photo every day (10:00 am IST).
    let next = 1;
    for (let d = 13; d <= 16; d++) {
      c.clock.set(IST(`2026-10-${d}T10:00:00`));
      for (let i = 0; i < 8; i++) await ramesh.api.post('/v1/coupons/redeem', { code: codes[next++], source: 'scan', deviceId: 'ramesh-phone' });
      await photo(ramesh);
    }
    home = (await ramesh.api.get('/v1/home')).body;
    expect(home.streak).toMatchObject({ completed: 5, doneToday: true });
    expect(home.lifetimePoints).toBe(33 * 20 + 25);
    // Crossed 500 lifetime points → Kaarigar, with 4 spins a day (C3-02).
    expect(home.rank.id).toBe('kaarigar');
    expect(home.spins.total).toBe(4);
    expect(home.withdraw.ready).toBe(false); // no PAN / UPI yet

    // Adds PAN and UPI (A3-06/07); the UPI name is checked against PAN.
    expect((await ramesh.api.post('/v1/me/kyc/pan', { pan: 'ABCDE1234F', name: 'Ramesh Kumar' })).body.masked).toBe('ABCDE••••F');
    expect((await ramesh.api.post('/v1/me/kyc/upi/check', { upiId: 'ramesh@ybl' })).body).toMatchObject({ matchesPan: true });
    await ramesh.api.put('/v1/me/kyc/upi', { upiId: 'ramesh@ybl' });
    expect((await ramesh.api.get('/v1/home')).body.withdraw.ready).toBe(true);

    // Withdraws ₹500 (B3-01).
    const w = (await ramesh.api.post('/v1/withdrawals', { amount: 500 })).body;
    expect(w).toMatchObject({ status: 'requested', upiId: 'ramesh@ybl' });
    expect((await ramesh.api.get('/v1/wallet')).body.points).toBe(685 - 500);

    // Next morning Ankit (accounts) approves with his PIN and pays from the company UPI app.
    c.clock.set(IST('2026-10-17T11:00:00'));
    const ankit = await staffLogin('ankit', 'ankit-pass-1', '1111');
    const queue = (await ankit.get('/v1/admin/withdrawals?status=requested')).body.rows;
    expect(queue.find((r: { id: string }) => r.id === w.id)).toMatchObject({ name: 'Ramesh Kumar', nameDiffers: false });
    await ankit.post(`/v1/admin/withdrawals/${w.id}/approve`, { pin: '1111' });
    await ankit.post(`/v1/admin/withdrawals/${w.id}/lock`);
    const proof = (await ankit.post('/v1/admin/uploads', { purpose: 'payment_proof', contentType: 'image/png' })).body.object;
    expect((await ankit.post(`/v1/admin/withdrawals/${w.id}/mark-paid`, { utr: '427188365520', proofObject: proof })).status).toBe(200);

    // Ramesh sees it as paid with the UTR and the proof (B3-04), on WhatsApp too (C4-06).
    const mine = (await ramesh.api.get(`/v1/withdrawals/${w.id}`)).body;
    expect(mine).toMatchObject({ status: 'paid', utr: '427188365520' });
    expect(mine.proofUrl).toBeTruthy();
    await c.runJob('outbox');
    expect(c.wa.sent.filter((m) => m.to === ramesh.mobile).map((m) => m.template)).toEqual(
      expect.arrayContaining(['rank_up', 'withdrawal_approved', 'withdrawal_paid']),
    );
    const paid = c.wa.sent.find((m) => m.to === ramesh.mobile && m.template === 'withdrawal_paid')!;
    expect(paid.vars).toMatchObject({ amount: '₹500', upi: 'ramesh@ybl', utr: '4271 8836 5520' });

    // Suresh's side: one friend, scanning; runs from the bonus + 10% of Ramesh's scans.
    const refs = (await suresh.api.get('/v1/me/referrals')).body;
    expect(refs).toMatchObject({ joined: 1, scanning: 1, runsEarned: 50 + 33 * 2 });
  });
});

describe('Pooja — earning runs and getting a T-shirt', () => {
  test('runs from games → book a gift → factory ships → delivered with photo', async () => {
    c.clock.set(IST('2026-10-19T09:00:00'));
    const owner = await c.ownerLogin();
    await owner.post('/v1/admin/staff', { loginId: 'shivansh', name: 'Shivansh', role: 'factory', password: 'shiv-pass-11', pin: '2222' });
    const pooja = await c.signup({ name: 'Pooja Devi' });
    const { codes } = await c.makeCodes(owner, 50, 20);

    // Five days: 10 coupons (→ scratch card), 3 spins, a photo.
    let k = 0;
    for (let d = 19; d <= 23; d++) {
      c.clock.set(IST(`2026-10-${d}T10:00:00`));
      for (let i = 0; i < 10; i++) await pooja.api.post('/v1/coupons/redeem', { code: codes[k++], source: 'scan' });
      for (let i = 0; i < 3; i++) await pooja.api.post('/v1/spins');
      await photo(pooja);
    }
    const cards = (await pooja.api.get('/v1/scratch-cards')).body.cards;
    expect(cards).toHaveLength(5);
    for (const card of cards) await pooja.api.post(`/v1/scratch-cards/${card.id}/reveal`);
    const runs = (await pooja.api.get('/v1/wallet')).body.runs;
    expect(runs).toBeGreaterThanOrEqual(80);

    // The T-shirt needs a size (B2-05); she books it (B2-06/07).
    expect((await pooja.api.post('/v1/gift-orders', { giftId: 'tshirt', address })).body.error.code).toBe('size_required');
    const order = (await pooja.api.post('/v1/gift-orders', { giftId: 'tshirt', size: 'L', address })).body;
    expect(order).toMatchObject({ step: 'booked', runs: 80, size: 'L' });

    // Shivansh's board shows it; 3 days later it's marked late (orange border, M4).
    const shiv = await staffLogin('shivansh', 'shiv-pass-11', '2222');
    c.clock.set(IST('2026-10-26T10:00:00'));
    const board = (await shiv.get('/v1/admin/gift-orders?step=booked')).body;
    expect(board.rows.find((o: { id: string }) => o.id === order.id)).toMatchObject({ stale: true, applicator: { name: 'Pooja Devi' } });
    // Factory staff can't touch money.
    expect((await shiv.get('/v1/admin/withdrawals')).status).toBe(403);

    await shiv.post(`/v1/admin/gift-orders/${order.id}/pack`);
    await shiv.post(`/v1/admin/gift-orders/${order.id}/ship`, { courierName: 'Delhivery', awb: '1Z9822114433', eta: '2026-10-30' });
    const mid = (await pooja.api.get(`/v1/gift-orders/${order.id}`)).body;
    expect(mid).toMatchObject({ step: 'shipped', courier: { name: 'Delhivery', awb: '1Z9822114433' }, eta: '2026-10-30' });

    c.clock.set(IST('2026-10-29T16:00:00'));
    const pic = (await shiv.post('/v1/admin/uploads', { purpose: 'delivery_photo', contentType: 'image/jpeg' })).body.object;
    await shiv.post(`/v1/admin/gift-orders/${order.id}/deliver`, { photoObject: pic, receivedBy: 'Pooja' });
    const done = (await pooja.api.get(`/v1/gift-orders/${order.id}`)).body;
    expect(done.step).toBe('delivered');
    expect(Object.values(done.dates).filter(Boolean)).toHaveLength(4); // booked, packed, shipped, delivered
    await c.runJob('outbox');
    expect(c.wa.sent.filter((m) => m.to === pooja.mobile).map((m) => m.template)).toEqual(
      expect.arrayContaining(['gift_packed', 'gift_shipped', 'gift_delivered']),
    );
  });
});

describe('Fraud — two accounts on one phone', () => {
  test('flag → cash on hold → owner checks → released → withdrawal goes through', async () => {
    c.clock.set(IST('2026-10-20T12:00:00'));
    const owner = await c.ownerLogin();
    const a = await c.signup({ name: 'Real Person', deviceId: 'shared-phone-1' });
    const b = await c.signup({ name: 'Second Account', deviceId: 'shared-phone-1' });
    await owner.post(`/v1/admin/applicators/${b.id}/adjust`, { wallet: 'points', amount: 600, reason: 'test' });
    await c.kyc(b);
    const blocked = await b.api.post('/v1/withdrawals', { amount: 500 });
    expect(blocked.body.error.code).toBe('under_check');
    expect((await b.api.get('/v1/wallet')).body.withdraw.blockers).toContain('under_check');

    const flags = (await owner.get('/v1/admin/fraud-flags')).body.flags;
    const f = flags.find((x: { mobile: string }) => x.mobile === b.mobile);
    expect(f.rule).toBe('shared_device');
    expect(f.details.otherAccounts).toContain(a.mobile);
    // Owner calls them: brothers sharing a phone. Cleared.
    await owner.post(`/v1/admin/fraud-flags/${f.id}/decide`, { decision: 'cleared', note: 'Brothers, one phone' });
    expect((await b.api.post('/v1/withdrawals', { amount: 500 })).status).toBe(200);
    const audit = (await owner.get(`/v1/admin/audit?entity=fraud_flag&entityId=${f.id}`)).body.rows;
    expect(audit[0]).toMatchObject({ action: 'flag_cleared', after: { note: 'Brothers, one phone' } });
  });
});

describe('Account safety', () => {
  test('forgot password on WhatsApp mid-week; the old phone is signed out', async () => {
    c.clock.set(IST('2026-10-21T08:00:00'));
    const u = await c.signup({ name: 'Forgetful' });
    expect((await c.api().get(`/v1/auth/registered?mobile=${u.mobile}`)).body.registered).toBe(true);
    await c.api().post('/webhooks/whatsapp', { entry: [{ changes: [{ value: { messages: [{ from: `91${u.mobile}`, type: 'text', text: { body: `RESET ${u.mobile}` } }] } }] }] });
    await c.runJob('outbox');
    const link = c.wa.sent.filter((m) => m.to === u.mobile && m.template === 'password_reset').pop()!.vars.link;
    const token = new URL(link).searchParams.get('t')!;
    // Link expires after 15 minutes.
    c.clock.advance(16 * 60_000);
    expect((await c.api().post('/v1/auth/reset-password', { token, password: 'newpass77' })).body.error.code).toBe('link_expired');
    // Asks again, uses it in time.
    await c.api().post('/webhooks/whatsapp', { entry: [{ changes: [{ value: { messages: [{ from: `91${u.mobile}`, type: 'text', text: { body: `RESET ${u.mobile}` } }] } }] }] });
    await c.runJob('outbox');
    const t2 = new URL(c.wa.sent.filter((m) => m.to === u.mobile && m.template === 'password_reset').pop()!.vars.link).searchParams.get('t')!;
    expect((await c.api().post('/v1/auth/reset-password', { token: t2, password: 'newpass77' })).status).toBe(200);
    expect((await c.api().post('/v1/auth/refresh', { refreshToken: u.refresh })).status).toBe(401);
    expect((await c.api().post('/v1/auth/login', { mobile: u.mobile, password: 'newpass77' })).status).toBe(200);
  });

  test('owner blocks an account: app stops working at once, and works again after unblock', async () => {
    const owner = await c.ownerLogin();
    const u = await c.signup();
    await owner.post(`/v1/admin/applicators/${u.id}/block`, { blocked: true, reason: 'Selling coupons' });
    expect((await u.api.get('/v1/home')).status).toBe(403);
    expect((await c.api().post('/v1/auth/refresh', { refreshToken: u.refresh })).status).toBe(401);
    expect((await c.api().post('/v1/auth/login', { mobile: u.mobile, password: 'secret123' })).body.error.code).toBe('blocked');
    await owner.post(`/v1/admin/applicators/${u.id}/block`, { blocked: false, reason: 'Checked — mistake' });
    expect((await c.api().post('/v1/auth/login', { mobile: u.mobile, password: 'secret123' })).status).toBe(200);
  });

  test('staff login locks after 5 wrong tries; an owner unlocks it', async () => {
    const owner = await c.ownerLogin();
    const s = (await owner.post('/v1/admin/staff', { loginId: 'anjali', name: 'Anjali', role: 'accounts', password: 'anjali-pass-1', pin: '3333' })).body;
    for (let i = 0; i < 5; i++) await c.api().post('/v1/admin/auth/login', { loginId: 'anjali', password: 'wrong-pass-1', pin: '3333' });
    expect((await c.api().post('/v1/admin/auth/login', { loginId: 'anjali', password: 'anjali-pass-1', pin: '3333' })).body.error.code).toBe('locked');
    await owner.patch(`/v1/admin/staff/${s.id}`, { unlock: true });
    expect((await c.api().post('/v1/admin/auth/login', { loginId: 'anjali', password: 'anjali-pass-1', pin: '3333' })).status).toBe(200);
  });
});

describe('Admin day — new coupon batch and a "my coupon is not working" call', () => {
  test('batch life-cycle and a helpline dispute lookup', async () => {
    c.clock.set(IST('2026-10-22T10:00:00'));
    const owner = await c.ownerLogin();
    await owner.post('/v1/admin/staff', { loginId: 'help1', name: 'Helpline', role: 'helpline', password: 'help-pass-11', pin: '4444' });
    await owner.post('/v1/admin/staff', { loginId: 'factory1', name: 'Factory', role: 'factory', password: 'fact-pass-11', pin: '5555' });
    const factory = await staffLogin('factory1', 'fact-pass-11', '5555');

    // Owner makes 500 × 10-point coupons; factory can't make batches.
    expect((await factory.post('/v1/admin/coupon-batches', { valuePoints: 10, quantity: 5 })).status).toBe(403);
    const batch = (await owner.post('/v1/admin/coupon-batches', { valuePoints: 10, quantity: 500, note: 'Pure Tile P10 Oct run' })).body;
    expect(batch.ref).toMatch(/^B-\d{4}$/);

    // Factory downloads the print file, then marks Printed → In market (can't skip back).
    const csv = (await factory.get(`/v1/admin/coupon-batches/${batch.id}/export.csv`)).body as string;
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(501);
    expect(new Set(lines.slice(1).map((l) => l.split(',')[0])).size).toBe(500); // all unique
    expect(lines[1]).toMatch(/^[A-HJ-NP-Z2-9]{8},B-\d{4}-00001,10,\d{4}-\d{2}-\d{2}$/);
    const code = lines[1].split(',')[0];
    await factory.patch(`/v1/admin/coupon-batches/${batch.id}`, { status: 'printed' });
    expect((await factory.patch(`/v1/admin/coupon-batches/${batch.id}`, { status: 'printed' })).body.error.code).toBe('bad_step');
    await factory.patch(`/v1/admin/coupon-batches/${batch.id}`, { status: 'in_market' });

    // Mohan scans it; later Raju calls: "ye coupon kaam nahi kar raha".
    const mohan = await c.signup({ name: 'Mohan Lal' });
    const raju = await c.signup({ name: 'Raju' });
    await mohan.api.post('/v1/coupons/redeem', { code, source: 'scan', lat: 31.63, lng: 74.87 });
    c.clock.advance(3600_000);
    expect((await raju.api.post('/v1/coupons/redeem', { code, source: 'typed' })).body.kind).toBe('used');

    const help = await staffLogin('help1', 'help-pass-11', '4444');
    const look = (await help.get(`/v1/admin/coupons/${code.toLowerCase()}`)).body;
    expect(look).toMatchObject({ status: 'repeat_try_blocked', value: 10, scannedBy: { name: 'Mohan Lal', lat: 31.63, lng: 74.87 } });
    expect(look.scannedBy.mobile).toMatch(/^\d{2}••••••\d{2}$/); // helpline sees a masked number
    expect(look.attempts.map((a: { result: string }) => a.result)).toEqual(['already_used', 'added']);
    // Helpline can look but not block.
    expect((await help.post(`/v1/admin/coupons/${code}/block`, { reason: 'x y z' })).status).toBe(403);

    const dash = (await owner.get('/v1/admin/dashboard')).body;
    expect(dash.scans.added).toBeGreaterThanOrEqual(1);
    expect(dash.pointsLiability).not.toBeNull(); // owners only
    expect((await help.get('/v1/admin/dashboard')).body.pointsLiability).toBeNull();
  });
});

describe('Time edges (India time)', () => {
  test('11:59 pm vs 12:01 am: new day for coupons, spins and quests', async () => {
    const owner = await c.ownerLogin();
    const { codes } = await c.makeCodes(owner, 4);
    c.clock.set(IST('2026-10-23T23:59:00'));
    const u = await c.signup();
    await u.api.post('/v1/coupons/redeem', { code: codes[0], source: 'scan' });
    for (let i = 0; i < 3; i++) await u.api.post('/v1/spins');
    expect((await u.api.get('/v1/home')).body).toMatchObject({ today: { coupons: 1 }, spins: { left: 0 } });
    c.clock.set(IST('2026-10-24T00:01:00'));
    const home = (await u.api.get('/v1/home')).body;
    expect(home).toMatchObject({ today: { coupons: 0 }, spins: { left: 3 } });
    expect((await u.api.get('/v1/quests')).body.quests.find((q: { id: string }) => q.id === 'scan').done).toBe(false);
    expect((await u.api.get('/v1/spins/today')).body.resetsInSec).toBeGreaterThan(86_000);
  });

  test('month end: the ₹15,000 cap and the 200-run referral cap restart on the 1st', async () => {
    const owner = await c.ownerLogin();
    c.clock.set(IST('2026-10-31T22:00:00'));
    const u = await c.signup({ name: 'Month End' });
    await owner.post(`/v1/admin/applicators/${u.id}/adjust`, { wallet: 'points', amount: 10_000, reason: 'test' });
    await owner.post(`/v1/admin/applicators/${u.id}/adjust`, { wallet: 'points', amount: 10_000, reason: 'test' });
    await c.kyc(u);
    for (let i = 0; i < 3; i++) expect((await u.api.post('/v1/withdrawals', { amount: 5000 })).status).toBe(200);
    expect((await u.api.post('/v1/withdrawals', { amount: 500 })).body.error.code).toBe('month_limit');
    c.clock.set(IST('2026-11-01T00:05:00'));
    expect((await u.api.post('/v1/withdrawals', { amount: 5000 })).status).toBe(200);
  });

  test('offline scans: a 2-day-old scan counts on its own day; older than 7 days is refused', async () => {
    const owner = await c.ownerLogin();
    const { codes } = await c.makeCodes(owner, 2);
    c.clock.set(IST('2026-10-25T12:00:00'));
    const u = await c.signup();
    const twoDays = await u.api.post('/v1/coupons/redeem', { code: codes[0], source: 'offline', scannedAt: IST('2026-10-23T18:00:00').toISOString() });
    expect(twoDays.body.kind).toBe('added');
    expect((await u.api.get('/v1/home')).body.today.coupons).toBe(0);
    const old = await u.api.post('/v1/coupons/redeem', { code: codes[1], source: 'offline', scannedAt: IST('2026-10-15T18:00:00').toISOString() });
    expect(old.body.error.code).toBe('bad_time');
  });

  test('owner changes a limit in Settings; it applies right away and is audited', async () => {
    c.clock.set(IST('2026-10-26T10:00:00'));
    const owner = await c.ownerLogin();
    const u = await c.signup({ name: 'Small Withdraw' });
    await owner.post(`/v1/admin/applicators/${u.id}/adjust`, { wallet: 'points', amount: 350, reason: 'test' });
    await c.kyc(u);
    expect((await u.api.post('/v1/withdrawals', { amount: 300 })).body.error.code).toBe('below_min');
    await owner.put('/v1/admin/settings/withdraw', { value: { minPoints: 300, maxPerRequest: 5000, maxPerMonth: 15000 } });
    expect((await u.api.post('/v1/withdrawals', { amount: 300 })).status).toBe(200);
    const audit = (await owner.get('/v1/admin/audit?entity=setting&entityId=withdraw')).body.rows[0];
    expect(audit).toMatchObject({ before: { minPoints: 500 }, after: { minPoints: 300 } });
    await owner.put('/v1/admin/settings/withdraw', { value: { minPoints: 500, maxPerRequest: 5000, maxPerMonth: 15000 } });
  });
});
