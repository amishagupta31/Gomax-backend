// High-traffic correctness: many requests for the same thing at the same
// moment. Run with TEST_DATABASE_URL (real Postgres, real parallelism) to
// exercise the row locks; on the default in-memory engine the same tests run
// one query at a time, which still checks the logic.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { gifts, scratchCards, waOutbox } from '../src/db/schema.js';
import { setup, type Ctx } from './helpers.js';
import { moneyInvariants } from './invariants.js';

let c: Ctx;
let owner: Awaited<ReturnType<Ctx['ownerLogin']>>;
beforeAll(async () => {
  c = await setup();
  owner = await c.ownerLogin();
});
afterAll(async () => {
  await c.close();
});
afterEach(async () => {
  expect(await moneyInvariants(c.db)).toEqual([]);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const all = <T = any>(n: number, f: (i: number) => Promise<T>): Promise<T[]> => Promise.all(Array.from({ length: n }, (_, i) => f(i)));
const codesOf = (rs: { body: { kind?: string; error?: { code: string } } }[]) =>
  rs.reduce<Record<string, number>>((m, r) => {
    const k = r.body.kind ?? r.body.error?.code ?? 'ok';
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});
const give = async (userId: string, wallet: 'points' | 'runs', amount: number) => {
  while (amount > 0) {
    const step = Math.min(10_000, amount);
    const r = await owner.post(`/v1/admin/applicators/${userId}/adjust`, { wallet, amount: step, reason: 'load test credit' });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    amount -= step;
  }
};

describe('rush hour', () => {
  test('60 applicators × 4 coupons, all at once (240 parallel scans) — every scan counted once', async () => {
    const users = await all(60, (i) => c.signup({ name: `Rush ${i}` }));
    const { codes } = await c.makeCodes(owner, 240, 20);
    const rs = await all(240, (i) => users[i % 60].api.post('/v1/coupons/redeem', { code: codes[i], source: 'scan' }));
    expect(codesOf(rs)).toEqual({ added: 240 });
    const homes = await all(60, (i) => users[i].api.get('/v1/home'));
    for (const h of homes) {
      expect(h.body.today.coupons).toBe(4);
      expect(h.body.points).toBe(4 * 20 + 25); // + first-coupon bonus, once
    }
  });

  test('25 people scan the same code at the same moment — exactly one wins', async () => {
    const users = await all(25, () => c.signup());
    const { codes } = await c.makeCodes(owner, 1);
    const rs = await all(25, (i) => users[i].api.post('/v1/coupons/redeem', { code: codes[0], source: 'scan' }));
    expect(codesOf(rs)).toEqual({ added: 1, used: 24 });
  });

  test('a brand-new user scans 6 codes at once — first-coupon bonus and invite bonus paid once', async () => {
    const inviter = await c.signup({ name: 'Inviter' });
    const u = await c.signup({ name: 'New Friend', referralCode: inviter.inviteCode });
    const { codes } = await c.makeCodes(owner, 6, 20);
    const rs = await all(6, (i) => u.api.post('/v1/coupons/redeem', { code: codes[i], source: 'scan' }));
    expect(codesOf(rs)).toEqual({ added: 6 });
    expect(rs.filter((r) => r.body.bonus === 25)).toHaveLength(1);
    const w = (await u.api.get('/v1/wallet')).body;
    expect(w.points).toBe(6 * 20 + 25);
    const inv = (await inviter.api.get('/v1/me/referrals')).body;
    expect(inv.runsEarned).toBe(50 + 6 * 2); // +50 once, 10% of each 20-pt scan
  });

  test('12 coupons at once on one phone — exactly one scratch card for the day', async () => {
    const u = await c.signup();
    const { codes } = await c.makeCodes(owner, 12);
    await all(12, (i) => u.api.post('/v1/coupons/redeem', { code: codes[i], source: 'scan' }));
    const cards = await c.db.select().from(scratchCards).where(eq(scratchCards.userId, u.id));
    expect(cards).toHaveLength(1);
  });
});

describe('double taps and repeated submits', () => {
  test('12 spin taps at once with 3 spins left — exactly 3 spins', async () => {
    const u = await c.signup();
    const rs = await all(12, () => u.api.post('/v1/spins'));
    const ok = rs.filter((r) => r.status === 200);
    expect(ok).toHaveLength(3);
    expect(rs.filter((r) => r.body.error?.code === 'no_spins_left')).toHaveLength(9);
    expect((await u.api.get('/v1/wallet')).body.runs).toBe(ok.reduce((a, r) => a + r.body.prizeRuns, 0));
  });

  test('withdraw tapped 6 times with points for one — one request, no overdraft', async () => {
    const u = await c.signup({ name: 'Double Tap' });
    await give(u.id, 'points', 1200);
    await c.kyc(u);
    const rs = await all(6, () => u.api.post('/v1/withdrawals', { amount: 1000 }));
    expect(codesOf(rs)).toEqual({ ok: 1, insufficient_balance: 5 });
    expect((await u.api.get('/v1/wallet')).body.points).toBe(200);
  });

  test('monthly ₹15,000 cap holds when 5 × ₹5,000 requests arrive together', async () => {
    const u = await c.signup({ name: 'Month Cap' });
    await give(u.id, 'points', 25_000);
    await c.kyc(u);
    const rs = await all(5, () => u.api.post('/v1/withdrawals', { amount: 5000 }));
    expect(codesOf(rs)).toEqual({ ok: 3, month_limit: 2 });
  });

  test('scratch card revealed 10 times at once — prize credited once', async () => {
    const u = await c.signup();
    const { codes } = await c.makeCodes(owner, 10);
    for (const code of codes) await u.api.post('/v1/coupons/redeem', { code, source: 'scan' });
    const id = (await u.api.get('/v1/scratch-cards')).body.cards[0].id;
    const before = (await u.api.get('/v1/wallet')).body;
    const rs = await all(10, () => u.api.post(`/v1/scratch-cards/${id}/reveal`));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const prize = rs[0].body.prize;
    const after = (await u.api.get('/v1/wallet')).body;
    expect(after[prize.kind] - before[prize.kind]).toBe(prize.amount);
  });

  test('challenge "Collect" pressed 6 times at once — reward paid once', async () => {
    const u = await c.signup();
    const { codes } = await c.makeCodes(owner, 20);
    for (const code of codes) await u.api.post('/v1/coupons/redeem', { code, source: 'scan' });
    const rs = await all(6, () => u.api.post('/v1/challenges/weekly/claim'));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
  });

  test('the same mobile signs up 8 times at once — one account, clean 409s', async () => {
    const rs = await all(8, () => c.api().post('/v1/auth/signup', { name: 'Same Number', mobile: '9811122233', password: 'secret123' }));
    expect(codesOf(rs)).toEqual({ ok: 1, mobile_taken: 7 });
  });

  test('the same refresh token used twice at once — only one new session', async () => {
    const u = await c.signup();
    const rs = await all(2, () => c.api().post('/v1/auth/refresh', { refreshToken: u.refresh }));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401]);
  });
});

describe('scarce stock and staff collisions', () => {
  test('12 people order the last 3 of a gift at once — exactly 3 orders', async () => {
    await owner.post('/v1/admin/gifts', { id: 'rush-cap', name: 'Rush cap', runsPrice: 10, stock: 3 });
    const users = await all(12, () => c.signup());
    for (const u of users) await give(u.id, 'runs', 10);
    const address = { name: 'Rush Buyer', mobile: '9876543210', street: 'Street 12345', city: 'Amritsar', pin: '143001' };
    const rs = await all(12, (i) => users[i].api.post('/v1/gift-orders', { giftId: 'rush-cap', address }));
    expect(codesOf(rs)).toEqual({ ok: 3, out_of_stock: 9 });
    const [g] = await c.db.select().from(gifts).where(eq(gifts.id, 'rush-cap'));
    expect(g.stock).toBe(0);
  });

  test('two staff mark the same payout paid at once — one wins', async () => {
    const u = await c.signup({ name: 'Two Payers' });
    await give(u.id, 'points', 1000);
    await c.kyc(u);
    const w = (await u.api.post('/v1/withdrawals', { amount: 1000 })).body;
    await owner.post(`/v1/admin/withdrawals/${w.id}/approve`, { pin: '1234' });
    const proof = async () => (await owner.post('/v1/admin/uploads', { purpose: 'payment_proof', contentType: 'image/jpeg' })).body.object;
    const [p1, p2] = [await proof(), await proof()];
    const rs = await Promise.all([
      owner.post(`/v1/admin/withdrawals/${w.id}/mark-paid`, { utr: '111122223333', proofObject: p1 }),
      owner.post(`/v1/admin/withdrawals/${w.id}/mark-paid`, { utr: '444455556666', proofObject: p2 }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  test('one UTR typed on two different payouts at once — only one accepts it', async () => {
    const users = await all(2, (i) => c.signup({ name: `Utr Person ${i}` }));
    const ws = [];
    for (const u of users) {
      await give(u.id, 'points', 600);
      await c.kyc(u);
      const w = (await u.api.post('/v1/withdrawals', { amount: 600 })).body;
      await owner.post(`/v1/admin/withdrawals/${w.id}/approve`, { pin: '1234' });
      ws.push(w);
    }
    const proof = (await owner.post('/v1/admin/uploads', { purpose: 'payment_proof', contentType: 'image/jpeg' })).body.object;
    const rs = await Promise.all(ws.map((w) => owner.post(`/v1/admin/withdrawals/${w.id}/mark-paid`, { utr: '999988887777', proofObject: proof })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)!.body.error.code).toBe('utr_used');
  });

  test('two outbox runs at once never send a message twice', async () => {
    await all(30, () => c.signup()); // 30 welcome messages queued
    c.wa.sent.length = 0;
    await Promise.all([c.runJob('outbox'), c.runJob('outbox'), c.runJob('outbox')]);
    const keys = c.wa.sent.map((m) => `${m.to}:${m.template}`);
    expect(new Set(keys).size).toBe(keys.length);
    const pending = await c.db.select().from(waOutbox).where(eq(waOutbox.status, 'pending'));
    expect(pending).toHaveLength(0);
  });
});

describe('login storm', () => {
  test('40 different people log in at the same moment', async () => {
    const users = await all(40, () => c.signup());
    const started = Date.now();
    const rs = await all(40, (i) => c.api().post('/v1/auth/login', { mobile: users[i].mobile, password: 'secret123' }));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    // argon2 is deliberately slow; 40 at once should still finish well under the 30 s request timeout.
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});
