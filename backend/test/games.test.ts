import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { setup, type Ctx } from './helpers.js';

let c: Ctx;
beforeAll(async () => {
  c = await setup();
});
afterAll(async () => {
  await c.close();
});

const photo = async (u: { api: ReturnType<Ctx['api']> }) => {
  const up = await u.api.post('/v1/uploads', { purpose: 'streak', contentType: 'image/jpeg' });
  return u.api.post('/v1/streak/photo', { object: up.body.object, takenAt: c.clock.now().toISOString(), lat: 31.63, lng: 74.87 });
};

describe('C2 spin', () => {
  test('3 spins a day for Naya Saathi, reset at 12 am IST; never 100', async () => {
    const u = await c.signup();
    const info = await u.api.get('/v1/spins/today');
    expect(info.body).toMatchObject({ total: 3, left: 3 });
    expect(info.body.wheel).toContain(100);
    const prizes = [];
    for (let i = 0; i < 3; i++) prizes.push((await u.api.post('/v1/spins')).body.prizeRuns);
    expect(prizes.every((p) => [5, 10].includes(p))).toBe(true);
    const none = await u.api.post('/v1/spins');
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('no_spins_left');
    expect((await u.api.get('/v1/wallet')).body.runs).toBe(prizes.reduce((a, b) => a + b, 0));

    // 10:30 am → next day 12:01 am IST
    c.clock.advance(13.6 * 3600_000);
    expect((await u.api.get('/v1/spins/today')).body.left).toBe(3);
  });

  test('owners cannot turn on the 100-runs prize', async () => {
    const owner = await c.ownerLogin();
    const r = await owner.put('/v1/admin/settings/spinOdds', { value: [{ runs: 5, weight: 50 }, { runs: 100, weight: 1 }] });
    expect(r.status).toBe(400);
    expect((await owner.put('/v1/admin/settings/spinOdds', { value: [{ runs: 20, weight: 1 }] })).status).toBe(200);
    const u = await c.signup();
    expect((await u.api.post('/v1/spins')).body.prizeRuns).toBe(20);
    await owner.put('/v1/admin/settings/spinOdds', { value: [{ runs: 5, weight: 55 }, { runs: 10, weight: 45 }] });
  });
});

describe('C2 challenges & quests', () => {
  test('weekly 20 coupons: progress, claim once, scratch-card reward', async () => {
    const owner = await c.ownerLogin();
    const { codes } = await c.makeCodes(owner, 20);
    const u = await c.signup();
    for (const code of codes.slice(0, 12)) await u.api.post('/v1/coupons/redeem', { code, source: 'scan' });
    const list = await u.api.get('/v1/challenges');
    const weekly = list.body.live.find((x: { id: string }) => x.id === 'weekly');
    expect(weekly).toMatchObject({ progress: 12, goal: 20, complete: false });
    expect(weekly.milestones.map((m: { reached: boolean }) => m.reached)).toEqual([true, true, false]);
    expect((await u.api.post('/v1/challenges/weekly/claim')).body.error.code).toBe('not_complete');

    for (const code of codes.slice(12)) await u.api.post('/v1/coupons/redeem', { code, source: 'scan' });
    const claim = await u.api.post('/v1/challenges/weekly/claim');
    expect(claim.body.runs).toBe(100);
    expect((await u.api.post('/v1/challenges/weekly/claim')).status).toBe(409);
    const after = await u.api.get('/v1/challenges');
    expect(after.body.live.find((x: { id: string }) => x.id === 'weekly')).toBeUndefined();
    expect(after.body.done[0]).toMatchObject({ id: 'weekly', runsWon: 100 });
  });

  test('ultra challenge counts only Ultra batches', async () => {
    const owner = await c.ownerLogin();
    const std = await c.makeCodes(owner, 2, 20, 'standard');
    const ultra = await c.makeCodes(owner, 2, 50, 'ultra');
    const u = await c.signup();
    for (const code of [...std.codes, ...ultra.codes]) await u.api.post('/v1/coupons/redeem', { code, source: 'scan' });
    expect((await u.api.get('/v1/challenges/ultra')).body.progress).toBe(2);
  });

  test('daily quests are credited once a day', async () => {
    const owner = await c.ownerLogin();
    const { codes } = await c.makeCodes(owner, 2);
    const u = await c.signup();
    await u.api.post('/v1/coupons/redeem', { code: codes[0], source: 'scan' });
    await u.api.post('/v1/coupons/redeem', { code: codes[1], source: 'scan' });
    const q = await u.api.get('/v1/quests');
    expect(q.body.quests.find((x: { id: string }) => x.id === 'scan')).toMatchObject({ done: true, reward: 10 });
    expect((await u.api.get('/v1/wallet')).body.runs).toBe(10);
  });
});

describe('C2 photo streak', () => {
  test('one photo a day; a missed day restarts; a rejected photo drops its day', async () => {
    const u = await c.signup();
    expect((await photo(u)).body).toMatchObject({ completed: 1, doneToday: true });
    expect((await photo(u)).body.error.code).toBe('already_today');
    c.clock.days(1);
    expect((await photo(u)).body.completed).toBe(2);
    c.clock.days(1);
    expect((await u.api.get('/v1/streak')).body).toMatchObject({ completed: 2, current: 3, doneToday: false });
    c.clock.days(1); // missed a day
    expect((await u.api.get('/v1/streak')).body.completed).toBe(0);
    expect((await photo(u)).body.completed).toBe(1);

    // Office rejects today's photo → the day no longer counts.
    const owner = await c.ownerLogin();
    const queue = await owner.get('/v1/admin/streak-photos');
    const todays = (await u.api.get('/v1/streak')).body.week.find((d: { status: string; date: string }) => d.status === 'done' && d.date === queue.body.rows.filter((r: { mobile: string }) => r.mobile === u.mobile).map((r: { day: string }) => r.day).sort().pop());
    const mine = queue.body.rows.find((r: { mobile: string; day: string }) => r.mobile === u.mobile && r.day === todays.date);
    await owner.post(`/v1/admin/streak-photos/${mine.id}/review`, { decision: 'rejected', reason: 'Not a work photo' });
    expect((await u.api.get('/v1/streak')).body.completed).toBe(0);
    c.clock.days(-3);
  });

  test('old photos and other people’s uploads are refused', async () => {
    const u = await c.signup();
    const v = await c.signup();
    const up = await u.api.post('/v1/uploads', { purpose: 'streak', contentType: 'image/jpeg' });
    const old = new Date(c.clock.now().getTime() - 60 * 60_000).toISOString();
    expect((await u.api.post('/v1/streak/photo', { object: up.body.object, takenAt: old })).body.error.code).toBe('photo_too_old');
    expect((await v.api.post('/v1/streak/photo', { object: up.body.object, takenAt: c.clock.now().toISOString() })).status).toBe(403);
  });

  test('15-day reward is paid once', async () => {
    const u = await c.signup();
    for (let d = 0; d < 15; d++) {
      await photo(u);
      c.clock.days(1);
    }
    c.clock.days(-15);
    const hist = await u.api.get('/v1/ledger?wallet=runs&kind=games&range=custom&from=2026-10-01&to=2026-12-31');
    const rewards = hist.body.rows.filter((r: { title: string }) => r.title.startsWith('Photo streak'));
    expect(rewards).toHaveLength(1);
    expect(rewards[0].amount).toBe(50);
  });
});

describe('C3 referrals', () => {
  test('+50 runs on a friend’s 1st coupon, 10% team share up 4 levels, capped at 200 a month', async () => {
    const owner = await c.ownerLogin();
    const top = await c.signup({ name: 'Top' });
    const l1 = await c.signup({ name: 'Level One', referralCode: top.inviteCode });
    const l2 = await c.signup({ name: 'Level Two', referralCode: l1.inviteCode });
    const { codes } = await c.makeCodes(owner, 30, 50);

    await l2.api.post('/v1/coupons/redeem', { code: codes[0], source: 'scan' });
    // l1: +50 bonus + 5 share; top: +5 share (level 2)
    expect((await l1.api.get('/v1/wallet')).body.runs).toBe(55);
    expect((await top.api.get('/v1/wallet')).body.runs).toBe(5);
    const refs = await l1.api.get('/v1/me/referrals');
    expect(refs.body).toMatchObject({ joined: 1, scanning: 1, runsEarned: 55 });

    // Cap: 200 runs a month for l1 in total.
    for (const code of codes.slice(1)) await l2.api.post('/v1/coupons/redeem', { code, source: 'scan' });
    expect((await l1.api.get('/v1/me/referrals')).body.runsEarned).toBe(200);

    // Levels are admin-only.
    const tree = await owner.get(`/v1/admin/applicators/${top.id}/tree`);
    expect(tree.body.levels.map((l: { people: unknown[] }) => l.people.length)).toEqual([1, 1, 0]);
  });

  test('no referral runs when inviter and friend share a phone', async () => {
    const owner = await c.ownerLogin();
    const a = await c.signup({ deviceId: 'shared-phone' });
    const b = await c.signup({ referralCode: a.inviteCode, deviceId: 'shared-phone' });
    const { codes } = await c.makeCodes(owner, 1);
    await b.api.post('/v1/coupons/redeem', { code: codes[0], source: 'scan', deviceId: 'shared-phone' });
    expect((await a.api.get('/v1/wallet')).body.runs).toBe(0);
  });
});

describe('Home, notifications, jobs', () => {
  test('home has what A2 needs; rank-up is announced', async () => {
    const owner = await c.ownerLogin();
    const u = await c.signup();
    const { codes } = await c.makeCodes(owner, 1, 500);
    const r = await u.api.post('/v1/coupons/redeem', { code: codes[0], source: 'scan' });
    expect(r.body.rankUp).toBe('Kaarigar');
    const home = (await u.api.get('/v1/home')).body;
    expect(home).toMatchObject({ points: 525, rank: { id: 'kaarigar' }, spins: { total: 4 }, firstCouponDone: true, withdraw: { ready: false } });
    expect(home.activeChallenge.id).toBe('weekly');
    const notes = await u.api.get('/v1/notifications');
    expect(notes.body.rows.some((n: { title: string }) => n.title === 'You are now Kaarigar!')).toBe(true);
    await u.api.post('/v1/notifications/read', { all: true });
    expect((await u.api.get('/v1/notifications')).body.unread).toBe(0);
  });

  test('jobs need the scheduler secret; outbox retries failures', async () => {
    expect((await c.api().post('/internal/jobs/outbox')).status).toBe(401);
    const u = await c.signup({ name: 'Retry Me' });
    const send = c.wa.send;
    c.wa.send = async () => {
      throw new Error('Meta down');
    };
    expect((await c.runJob('outbox')).body.failed).toBeGreaterThan(0);
    c.wa.send = send;
    c.clock.advance(2 * 60_000);
    await c.runJob('outbox');
    expect(c.wa.sent.some((m) => m.to === u.mobile && m.template === 'welcome')).toBe(true);
    expect((await c.runJob('daily-summary')).status).toBe(200);
    expect((await c.runJob('housekeeping')).status).toBe(200);
  });
});
