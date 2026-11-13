import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { notifications, referralCredits, userKyc, users } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { UPI_RE } from '../lib/kyc.js';
import { getSettings } from '../lib/settings.js';
import { requireUser } from '../plugins/auth.js';
import { getUser, homeCounts, kycState, rankView } from '../services/account.js';
import { rankFor } from '../lib/ranks.js';
import { secondsToIstMidnight } from '../lib/time.js';
import { activeChallenge } from '../services/challenges.js';
import { streakState } from '../services/streak.js';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, config, kyc, now } = app.deps;
  app.addHook('preHandler', requireUser);

  // C4-01 Profile
  app.get('/me', async (req) => {
    const u = req.currentUser;
    const s = await getSettings(db);
    return {
      id: u.id,
      name: u.name,
      mobile: u.mobile,
      city: u.city,
      birthday: u.birthday,
      anniversary: u.anniversary,
      language: u.language,
      whatsappOptIn: u.whatsappOptIn,
      inviteCode: u.inviteCode,
      points: u.points,
      runs: u.runs,
      lifetimePoints: u.lifetimePoints,
      cashHold: u.cashHold,
      rank: rankView(u.lifetimePoints, s),
      kyc: await kycState(db, u.id),
      createdAt: u.createdAt.toISOString(),
    };
  });

  app.patch(
    '/me',
    {
      schema: {
        body: z
          .object({
            name: z.string().trim().min(2).max(80),
            city: z.string().trim().max(60).nullable(),
            birthday: IsoDate.nullable(),
            anniversary: IsoDate.nullable(),
            language: z.enum(['hi', 'en', 'pa']),
            whatsappOptIn: z.boolean(),
          })
          .partial(),
      },
    },
    async (req) => {
      if (Object.keys(req.body).length) await db.update(users).set({ ...req.body, updatedAt: now() }).where(eq(users.id, req.userId));
      return { ok: true };
    },
  );

  // C4-02 Register FCM device token for push notifications.
  app.post(
    '/me/device-token',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { body: z.object({ token: z.string().min(10).max(500) }) } },
    async (req) => {
      await db.update(users).set({ fcmToken: req.body.token, updatedAt: now() }).where(eq(users.id, req.userId));
      return { ok: true };
    },
  );

  // A2/A3 Home: everything the home screen needs in one call.
  app.get('/home', async (req) => {
    const t = now();
    const u = req.currentUser;
    const s = await getSettings(db);
    const unreadQ = db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, u.id), isNull(notifications.readAt)))
      .then((r) => r[0].n);
    const [counts, streak, active, unread] = await Promise.all([homeCounts(db, u.id, t), streakState(db, u.id, t), activeChallenge(db, u.id, t), unreadQ]);
    const today = counts.today;
    const kycS = counts.kyc;
    const cards = counts.cards;
    const spinsTotal = rankFor(u.lifetimePoints, s.ranks).current.spins;
    const spin = { total: spinsTotal, used: counts.spinsUsed, left: Math.max(0, spinsTotal - counts.spinsUsed), resetsInSec: secondsToIstMidnight(t) };
    return {
      name: u.name,
      points: u.points,
      runs: u.runs,
      lifetimePoints: u.lifetimePoints,
      rank: rankView(u.lifetimePoints, s),
      today: { coupons: today.count, points: today.points, perScratchCard: s.scratch.couponsPerCard },
      spins: spin,
      streak: { day: streak.current, completed: streak.completed, doneToday: streak.doneToday },
      scratchCardsReady: cards,
      kyc: kycS,
      unreadNotifications: unread,
      withdraw: { minPoints: s.withdraw.minPoints, ready: u.points >= s.withdraw.minPoints && Boolean(kycS.upi) && !u.cashHold },
      firstCouponDone: Boolean(u.firstCouponAt),
      activeChallenge: active
        ? { id: active.id, title: active.title, progress: active.progress, goal: active.goal, rewardRuns: active.rewardRuns, endsAt: active.endsAt }
        : null,
    };
  });

  app.get('/me/rank', async (req) => {
    const u = req.currentUser;
    return { lifetimePoints: u.lifetimePoints, ...rankView(u.lifetimePoints, await getSettings(db)) };
  });

  // C3-01: "12 people joined with your code · you got 4,250 runs". Levels stay admin-only.
  app.get('/me/referrals', async (req) => {
    const u = req.currentUser;
    const joined = await db
      .select({ name: users.name, joinedAt: users.createdAt, firstCouponAt: users.firstCouponAt })
      .from(users)
      .where(eq(users.referredBy, u.id))
      .orderBy(desc(users.createdAt))
      .limit(200);
    const [earned] = await db
      .select({ runs: sql<number>`coalesce(sum(${referralCredits.runs}), 0)::int` })
      .from(referralCredits)
      .where(eq(referralCredits.earnerId, u.id));
    const [{ n: active }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.referredBy, u.id), isNotNull(users.firstCouponAt)));
    const s = await getSettings(db);
    return {
      code: u.inviteCode,
      runsPerInvite: s.referral.firstCouponBonusRuns,
      joined: joined.length,
      scanning: active,
      runsEarned: earned.runs,
      people: joined.map((p) => ({ firstName: p.name.split(' ')[0], joinedAt: p.joinedAt.toISOString(), scanning: Boolean(p.firstCouponAt) })),
    };
  });

  // A3-07 Add UPI — Razorpay validates the UPI ID and returns the registered name.
  const lookupUpi = async (_userId: string, upi: string) => {
    if (!UPI_RE.test(upi)) throw badRequest('bad_upi', 'Check the UPI ID');
    const r = await kyc.lookupUpi(upi);
    if (!r.ok) throw badRequest('upi_not_found', r.error);
    return { name: r.name || '', matchesPan: true };
  };

  app.post(
    '/me/kyc/upi/check',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { body: z.object({ upiId: z.string().trim().min(4).max(60) }) } },
    async (req) => lookupUpi(req.userId, req.body.upiId),
  );

  app.put(
    '/me/kyc/upi',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { body: z.object({ upiId: z.string().trim().min(4).max(60) }) } },
    async (req) => {
      const r = await lookupUpi(req.userId, req.body.upiId);
      const row = { upiId: req.body.upiId, upiName: r.name, upiMatchesPan: true, upiVerifiedAt: now(), updatedAt: now() };
      await db.insert(userKyc).values({ userId: req.userId, ...row }).onConflictDoUpdate({ target: userKyc.userId, set: row });
      return { id: row.upiId, name: r.name };
    },
  );
};

export default routes;
