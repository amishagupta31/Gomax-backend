import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { couponBatches, fraudFlags, users } from '../src/db/schema.js';
import { setup, type Ctx } from './helpers.js';

let c: Ctx;
beforeAll(async () => {
  c = await setup();
});
afterAll(async () => {
  await c.close();
});

describe('B1 scan', () => {
  test('first coupon adds value + 25 bonus; the same code again is "already used"', async () => {
    const owner = await c.ownerLogin();
    const { codes } = await c.makeCodes(owner, 2, 20);
    const u = await c.signup({ name: 'Ram Kumar' });
    // Typed with the printed GMX- prefix and spaces still works.
    const r = await u.api.post('/v1/coupons/redeem', { code: `GMX-${codes[0].slice(0, 4)} ${codes[0].slice(4)}`, source: 'typed' });
    expect(r.body.kind).toBe('added');
    expect(r.body.value).toBe(20);
    expect(r.body.bonus).toBe(25);
    expect(r.body.balance.points).toBe(45);
    expect(r.body.today.count).toBe(1);

    const again = await u.api.post('/v1/coupons/redeem', { code: codes[0], source: 'scan' });
    expect(again.body.kind).toBe('used');
    expect(again.body.byYou).toBe(true);

    // QR payload as a URL.
    const second = await u.api.post('/v1/coupons/redeem', { code: `https://gomax.in/c/${codes[1]}`, source: 'scan' });
    expect(second.body).toMatchObject({ kind: 'added', value: 20, bonus: 0 });

    const ledger = await u.api.get('/v1/ledger?wallet=points');
    expect(ledger.body.rows.map((x: { title: string }) => x.title)).toEqual(['Coupon scan', 'Bonus: first scan', 'Coupon scan']);
    expect(ledger.body.totals.earned).toBe(65);
  });

  test('wrong code, not in market, expired, blocked — every try is logged', async () => {
    const owner = await c.ownerLogin();
    const u = await c.signup();
    expect((await u.api.post('/v1/coupons/redeem', { code: 'HELLO', source: 'typed' })).body.kind).toBe('invalid');

    const fresh = await owner.post('/v1/admin/coupon-batches', { valuePoints: 10, quantity: 1 });
    const [code] = (await owner.get(`/v1/admin/coupon-batches/${fresh.body.id}/export.csv`)).body.split('\n')[1].split(',');
    expect((await u.api.post('/v1/coupons/redeem', { code, source: 'scan' })).body.kind).toBe('not_active');

    const { batchId, codes } = await c.makeCodes(owner, 2, 10);
    await c.db.update(couponBatches).set({ expiresAt: new Date('2026-01-01') }).where(eq(couponBatches.id, batchId));
    expect((await u.api.post('/v1/coupons/redeem', { code: codes[0], source: 'scan' })).body.kind).toBe('expired');

    const other = await c.makeCodes(owner, 1, 10);
    await owner.post(`/v1/admin/coupons/${other.codes[0]}/block`, { reason: 'Lost in transit' });
    expect((await u.api.post('/v1/coupons/redeem', { code: other.codes[0], source: 'scan' })).body.kind).toBe('blocked');

    const scans = await u.api.get('/v1/me/scans?range=today');
    expect(scans.body.summary).toMatchObject({ added: 0, failed: 4 });
    const lookup = await owner.get(`/v1/admin/coupons/${code}`);
    expect(lookup.body.attempts[0].result).toBe('not_active');
  });

  test('another account trying a used code is flagged and put on hold', async () => {
    const owner = await c.ownerLogin();
    const { codes } = await c.makeCodes(owner, 1);
    const a = await c.signup();
    const b = await c.signup();
    await a.api.post('/v1/coupons/redeem', { code: codes[0], source: 'scan' });
    const r = await b.api.post('/v1/coupons/redeem', { code: codes[0], source: 'scan' });
    expect(r.body).toMatchObject({ kind: 'used', byYou: false });
    const [f] = await c.db.select().from(fraudFlags).where(eq(fraudFlags.userId, b.id));
    expect(f.rule).toBe('used_code_retry');
    const [ub] = await c.db.select({ hold: users.cashHold }).from(users).where(eq(users.id, b.id));
    expect(ub.hold).toBe(true);
    // Owner clears it → hold released.
    await owner.post(`/v1/admin/fraud-flags/${f.id}/decide`, { decision: 'cleared' });
    const [ub2] = await c.db.select({ hold: users.cashHold }).from(users).where(eq(users.id, b.id));
    expect(ub2.hold).toBe(false);
  });

  test('two people scanning the same code at once: exactly one wins', async () => {
    const owner = await c.ownerLogin();
    const { codes } = await c.makeCodes(owner, 1);
    const [a, b] = [await c.signup(), await c.signup()];
    const rs = await Promise.all([a.api.post('/v1/coupons/redeem', { code: codes[0], source: 'scan' }), b.api.post('/v1/coupons/redeem', { code: codes[0], source: 'scan' })]);
    expect(rs.map((r) => r.body.kind).sort()).toEqual(['added', 'used']);
  });

  test('10th coupon of the day gives one scratch card; prize is fixed and reveal is idempotent', async () => {
    const owner = await c.ownerLogin();
    const { codes } = await c.makeCodes(owner, 11);
    const u = await c.signup();
    let last;
    for (const code of codes.slice(0, 10)) last = await u.api.post('/v1/coupons/redeem', { code, source: 'scan' });
    expect(last!.body.reward.kind).toBe('scratch');
    const eleventh = await u.api.post('/v1/coupons/redeem', { code: codes[10], source: 'scan' });
    expect(eleventh.body.reward).toBeNull();

    const list = await u.api.get('/v1/scratch-cards');
    expect(list.body.cards).toHaveLength(1);
    expect(list.body.cards[0].prize).toBeNull(); // hidden until revealed
    const id = list.body.cards[0].id;
    const r1 = await u.api.post(`/v1/scratch-cards/${id}/reveal`);
    const r2 = await u.api.post(`/v1/scratch-cards/${id}/reveal`);
    expect(r2.body.prize).toEqual(r1.body.prize);
    expect(r2.body.alreadyRevealed).toBe(true);
    // Credited once.
    const hist = await u.api.get('/v1/games/history?kind=scratch&range=today');
    expect(hist.body.rows).toHaveLength(1);
  });

  test('scratch cards expire after 7 days', async () => {
    const owner = await c.ownerLogin();
    const { codes } = await c.makeCodes(owner, 10);
    const u = await c.signup();
    for (const code of codes) await u.api.post('/v1/coupons/redeem', { code, source: 'scan' });
    const id = (await u.api.get('/v1/scratch-cards')).body.cards[0].id;
    c.clock.days(8);
    expect((await u.api.post(`/v1/scratch-cards/${id}/reveal`)).body.error.code).toBe('expired');
    expect((await u.api.get('/v1/scratch-cards')).body.cards[0].state).toBe('expired');
    c.clock.days(-8);
  });

  test('scan burst flag (>15 in 5 min)', async () => {
    const owner = await c.ownerLogin();
    const { codes } = await c.makeCodes(owner, 16);
    const u = await c.signup();
    for (const code of codes) await u.api.post('/v1/coupons/redeem', { code, source: 'scan' });
    const flags = await c.db.select().from(fraudFlags).where(eq(fraudFlags.userId, u.id));
    expect(flags.map((f) => f.rule)).toContain('scan_burst');
  });

  test('cursor pagination walks every scan once, newest first', async () => {
    const owner = await c.ownerLogin();
    const { codes } = await c.makeCodes(owner, 7);
    const u = await c.signup();
    for (const code of codes) await u.api.post('/v1/coupons/redeem', { code, source: 'scan' });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: { status: number; body: any } = await u.api.get(`/v1/me/scans?range=today&limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      seen.push(...r.body.rows.map((x: { code: string }) => x.code));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...codes].reverse());

    const l1 = await u.api.get('/v1/ledger?wallet=points&limit=4');
    const l2 = await u.api.get(`/v1/ledger?wallet=points&limit=4&cursor=${l1.body.nextCursor}`);
    const ids = [...l1.body.rows, ...l2.body.rows].map((x: { id: string }) => x.id);
    expect(new Set(ids).size).toBe(8); // 7 scans + first-coupon bonus, no repeats
    expect(l2.body.nextCursor).toBeNull();
    expect((await u.api.get('/v1/ledger?cursor=abc')).body.error.code).toBe('bad_cursor');
  });

  test('offline queue keeps the original scan time', async () => {
    const owner = await c.ownerLogin();
    const { codes } = await c.makeCodes(owner, 1);
    const u = await c.signup();
    const at = new Date(c.clock.now().getTime() - 26 * 3600_000).toISOString(); // yesterday
    const r = await u.api.post('/v1/coupons/redeem', { code: codes[0], source: 'offline', scannedAt: at });
    expect(r.body.kind).toBe('added');
    expect(r.body.today.count).toBe(1); // counted on the day it was scanned
    expect((await u.api.get('/v1/home')).body.today.coupons).toBe(0);
  });
});
