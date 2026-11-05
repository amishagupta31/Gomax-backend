import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { referralCredits, scans, users } from '../../db/schema.js';
import { getSettings } from '../../lib/settings.js';
import { addDays, istDay, istDayStart, istMonth } from '../../lib/time.js';
import { requireStaff } from '../../plugins/auth.js';

// D1 dashboard extras (14-day chart, top applicators, active in 30 days) and
// D6b referral overview (top referrers, runs this month vs cap).
const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, now } = app.deps;

  app.get(
    '/dashboard/insights',
    { preHandler: requireStaff('accounts', 'helpline'), schema: { querystring: z.object({ days: z.coerce.number().int().min(7).max(60).default(14) }) } },
    async (req) => {
      const t = now();
      const today = istDay(t);
      const first = addDays(today, -(req.query.days - 1));
      const rows = await db
        .select({ day: scans.day, coupons: sql<number>`count(*)::int`, points: sql<number>`coalesce(sum(${scans.points}), 0)::int` })
        .from(scans)
        .where(and(eq(scans.result, 'added'), gte(scans.day, first)))
        .groupBy(scans.day);
      const byDay = new Map(rows.map((r) => [String(r.day), r]));
      const daily = Array.from({ length: req.query.days }, (_, i) => {
        const day = addDays(first, i);
        const r = byDay.get(day);
        return { day, coupons: r?.coupons ?? 0, points: r?.points ?? 0 };
      });

      const since30 = istDayStart(addDays(today, -29));
      const [active] = await db
        .select({ n: sql<number>`count(distinct ${scans.userId})::int` })
        .from(scans)
        .where(and(eq(scans.result, 'added'), gte(scans.scannedAt, since30)));
      const [registered] = await db.select({ n: sql<number>`count(*)::int` }).from(users);

      // "Top applicators — this month": coupons added in the IST month.
      const monthStart = istDayStart(`${istMonth(t)}-01`);
      const top = await db
        .select({
          id: users.id,
          name: users.name,
          mobile: users.mobile,
          city: users.city,
          lifetimePoints: users.lifetimePoints,
          coupons: sql<number>`count(*)::int`,
          points: sql<number>`coalesce(sum(${scans.points}), 0)::int`,
        })
        .from(scans)
        .innerJoin(users, eq(users.id, scans.userId))
        .where(and(eq(scans.result, 'added'), gte(scans.scannedAt, monthStart)))
        .groupBy(users.id)
        .orderBy(desc(sql`count(*)`))
        .limit(10);

      return { daily, activeApplicators30d: active.n, registered: registered.n, topApplicators: top };
    },
  );

  app.get(
    '/referrals/top',
    { preHandler: requireStaff('accounts', 'helpline'), schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }) } },
    async (req) => {
      const month = istMonth(now());
      const s = await getSettings(db);
      // Direct joins (L1) per inviter.
      const l1 = await db
        .select({ id: users.referredBy, n: sql<number>`count(*)::int`, scanning: sql<number>`count(${users.firstCouponAt})::int` })
        .from(users)
        .where(isNotNull(users.referredBy))
        .groupBy(users.referredBy)
        .orderBy(desc(sql`count(*)`))
        .limit(req.query.limit);
      if (!l1.length) return { rows: [], monthlyCapRuns: s.referral.monthlyCapRuns };
      const ids = l1.map((r) => r.id!);
      const people = await db
        .select({ id: users.id, name: users.name, mobile: users.mobile, city: users.city, inviteCode: users.inviteCode })
        .from(users)
        .where(inArray(users.id, ids));
      const runs = await db
        .select({
          id: referralCredits.earnerId,
          total: sql<number>`coalesce(sum(${referralCredits.runs}), 0)::int`,
          month: sql<number>`coalesce(sum(${referralCredits.runs}) filter (where ${referralCredits.monthKey} = ${month}), 0)::int`,
        })
        .from(referralCredits)
        .where(inArray(referralCredits.earnerId, ids))
        .groupBy(referralCredits.earnerId);
      return {
        monthlyCapRuns: s.referral.monthlyCapRuns,
        rows: l1.map((r) => {
          const p = people.find((x) => x.id === r.id)!;
          const c = runs.find((x) => x.id === r.id);
          return { ...p, joined: r.n, joinedScanning: r.scanning, runsEarned: c?.total ?? 0, runsThisMonth: c?.month ?? 0 };
        }),
      };
    },
  );
};

export default routes;
