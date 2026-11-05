import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { couponBatches, coupons, gifts, scans, users } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { page, PageQuery, timeCursor, timeKey } from '../lib/page.js';
import { normalizeCode } from '../lib/codes.js';
import { post } from '../lib/ledger.js';
import { notify, queueWhatsApp } from '../lib/notify.js';
import { rankFor } from '../lib/ranks.js';
import { getSettings } from '../lib/settings.js';
import { istDay, istDayStart, addDays } from '../lib/time.js';
import { requireUser } from '../plugins/auth.js';
import { todayAdded } from '../services/account.js';
import { checkScanFraud, checkWrongCodes, raiseFlag } from '../services/fraud.js';
import { awardQuest, issueScratchCard, payReferrals } from '../services/rewards.js';

// B1 Scan. Every try is saved, failed ones too (D3). Codes must belong to an
// "In market" batch, not blocked, not expired, not used.
const REASON: Record<string, string> = {
  already_used: 'Already used',
  wrong_code: 'Not a GoMax coupon',
  expired: 'Expired',
  not_active: 'Not active yet',
  blocked: 'Blocked',
};

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, now } = app.deps;

  app.post(
    '/coupons/redeem',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
      schema: {
        body: z.object({
          code: z.string().min(1).max(300),
          source: z.enum(['scan', 'typed', 'offline']),
          lat: z.number().min(-90).max(90).optional(),
          lng: z.number().min(-180).max(180).optional(),
          accuracy: z.number().min(0).optional(),
          deviceId: z.string().max(100).optional(),
          deviceModel: z.string().max(100).optional(),
          appVersion: z.string().max(20).optional(),
          /** Offline queue: the time the code was scanned on the phone. */
          scannedAt: z.iso.datetime().optional(),
        }),
      },
    },
    async (req) => {
      const b = req.body;
      const t = now();
      let at = t;
      if (b.source === 'offline' && b.scannedAt) {
        at = new Date(b.scannedAt);
        if (at > new Date(t.getTime() + 5 * 60_000) || at < new Date(t.getTime() - 7 * 86_400_000)) {
          throw badRequest('bad_time', 'Offline scans must be sent within 7 days');
        }
      }
      const s = await getSettings(db);
      const code = normalizeCode(b.code);
      const base = {
        userId: req.userId,
        codeRaw: b.code.slice(0, 300),
        code,
        source: b.source,
        lat: b.lat ?? null,
        lng: b.lng ?? null,
        accuracy: b.accuracy ?? null,
        deviceId: b.deviceId ?? null,
        deviceModel: b.deviceModel ?? null,
        appVersion: b.appVersion ?? null,
        scannedAt: at,
        day: istDay(at),
      };

      const result = await db.transaction(async (tx) => {
        const fail = async (result: 'already_used' | 'wrong_code' | 'expired' | 'not_active' | 'blocked', couponId: number | null = null) => {
          await tx.insert(scans).values({ ...base, result, couponId });
          return { result, couponId };
        };
        if (!code) return fail('wrong_code');

        // Row lock on the coupon only: two phones scanning the same code at
        // once — only one wins — while scans of other codes in the batch run freely.
        const [coupon] = await tx.select().from(coupons).where(eq(coupons.code, code)).for('update');
        if (!coupon) return fail('wrong_code');
        const [batch] = await tx.select().from(couponBatches).where(eq(couponBatches.id, coupon.batchId));
        const c = { coupon, batch };
        if (c.coupon.blocked || c.batch.status === 'blocked') return fail('blocked', c.coupon.id);
        if (c.coupon.scannedBy) {
          const r = await fail('already_used', c.coupon.id);
          return { ...r, usedAt: c.coupon.scannedAt, byYou: c.coupon.scannedBy === req.userId, otherUser: c.coupon.scannedBy };
        }
        if (c.batch.status !== 'in_market') return fail('not_active', c.coupon.id);
        if (c.batch.expiresAt < at) return fail('expired', c.coupon.id);

        const value = c.batch.valuePoints;
        const [scan] = await tx.insert(scans).values({ ...base, result: 'added', couponId: c.coupon.id, points: value }).returning({ id: scans.id });
        await tx.update(coupons).set({ scannedBy: req.userId, scannedAt: at }).where(eq(coupons.id, c.coupon.id));

        const [u] = await tx.select().from(users).where(eq(users.id, req.userId)).for('update');
        const rankBefore = rankFor(u.lifetimePoints, s.ranks).current;
        const runsBefore = u.runs;
        await post(tx, { at, userId: u.id, wallet: 'points', kind: 'scan', amount: value, title: 'Coupon scan', sub: `…${code.slice(-4)}`, ref: `scan:${scan.id}` });

        const firstCoupon = !u.firstCouponAt;
        let bonus = 0;
        if (firstCoupon) {
          await tx.update(users).set({ firstCouponAt: at }).where(eq(users.id, u.id));
          if (s.firstCouponBonus > 0) {
            bonus = s.firstCouponBonus;
            await post(tx, { at, userId: u.id, wallet: 'points', kind: 'bonus', amount: bonus, title: 'Bonus: first scan', sub: 'Welcome gift' });
          }
        }
        if (b.deviceId && b.deviceId !== u.lastDeviceId) await tx.update(users).set({ lastDeviceId: b.deviceId }).where(eq(users.id, u.id));

        await payReferrals(tx, s, { id: u.id, name: u.name, referredBy: u.referredBy, lastDeviceId: b.deviceId ?? u.lastDeviceId }, scan.id, value, firstCoupon, t);
        await awardQuest(tx, s, u.id, 'scan', at);

        const today = await todayAdded(tx, u.id, at);
        let scratchCardId: string | null = null;
        if (today.count === s.scratch.couponsPerCard) {
          scratchCardId = await issueScratchCard(tx, s, u.id, 'coupons', at);
          if (scratchCardId) {
            await notify(tx, u.id, { kind: 'games', title: 'You got a scratch card', body: `${s.scratch.couponsPerCard} coupons scanned today`, art: 'ticket', link: { route: 'ScratchCards' } });
            await queueWhatsApp(tx, u.id, 'scratch_card', {});
          }
        }

        const [after] = await tx.select({ points: users.points, runs: users.runs, lifetimePoints: users.lifetimePoints }).from(users).where(eq(users.id, u.id));
        const rankAfter = rankFor(after.lifetimePoints, s.ranks);
        if (rankAfter.current.id !== rankBefore.id) {
          const benefits = `${rankAfter.current.spins} spins a day${rankAfter.current.runsBoostPct ? ` + ${rankAfter.current.runsBoostPct}% more runs` : ''}`;
          await notify(tx, u.id, { kind: 'games', title: `You are now ${rankAfter.current.name}!`, body: benefits, art: 'crown', link: { route: 'RankBenefits' } });
          await queueWhatsApp(tx, u.id, 'rank_up', {
            rank: rankAfter.current.name,
            benefits,
            next: rankAfter.next ? `${rankAfter.next.name} at ${rankAfter.next.min.toLocaleString('en-IN')} points` : 'top rank',
          });
        }
        // A gift newly within reach (B1-03d "Gift unlocked").
        let gift: { id: string; name: string } | null = null;
        if (after.runs > runsBefore) {
          const [g] = await tx
            .select({ id: gifts.id, name: gifts.name })
            .from(gifts)
            .where(and(eq(gifts.active, true), sql`${gifts.runsPrice} > ${runsBefore}`, sql`${gifts.runsPrice} <= ${after.runs}`))
            .orderBy(desc(gifts.runsPrice))
            .limit(1);
          gift = g ?? null;
        }
        await checkScanFraud(tx, s.fraud, u.id, at, b.lat != null && b.lng != null ? { lat: b.lat, lng: b.lng } : null, t);

        return {
          result: 'added' as const,
          value,
          bonus,
          balance: { points: after.points, runs: after.runs },
          today: { count: today.count, points: today.points, perCard: s.scratch.couponsPerCard },
          reward: scratchCardId ? { kind: 'scratch' as const, scratchCardId } : gift ? { kind: 'gift' as const, gift } : null,
          rankUp: rankAfter.current.id !== rankBefore.id ? rankAfter.current.name : null,
        };
      });

      if (result.result === 'wrong_code') await checkWrongCodes(db, req.userId, t);
      if (result.result === 'already_used' && 'otherUser' in result && result.otherUser && !result.byYou) {
        // "Same code tried again" by a different account (D1).
        await raiseFlag(db, req.userId, 'used_code_retry', { code }, t);
      }

      if (result.result === 'added') return { kind: 'added', ...result, result: undefined };
      if (result.result === 'already_used' && 'usedAt' in result) {
        return { kind: 'used', reason: REASON.already_used, usedAt: result.usedAt?.toISOString() ?? null, byYou: result.byYou };
      }
      return { kind: result.result === 'wrong_code' ? 'invalid' : result.result, reason: REASON[result.result] };
    },
  );

  // B1-07 My scans: today / week / month, filter by status, grouped by day on the app.
  app.get(
    '/me/scans',
    {
      preHandler: requireUser,
      schema: {
        querystring: z.object({
          range: z.enum(['today', 'week', 'month']).default('today'),
          status: z.enum(['all', 'added', 'failed']).default('all'),
          ...PageQuery,
        }),
      },
    },
    async (req) => {
      const { range, status, limit, cursor } = req.query;
      const t = now();
      const from = istDayStart(addDays(istDay(t), range === 'today' ? 0 : range === 'week' ? -6 : -29));
      const where = and(eq(scans.userId, req.userId), gte(scans.scannedAt, from), lt(scans.scannedAt, new Date(t.getTime() + 60_000)));
      const rows = await db
        .select()
        .from(scans)
        .where(
          and(
            status === 'all' ? where : status === 'added' ? and(where, eq(scans.result, 'added')) : and(where, sql`${scans.result} <> 'added'`),
            timeCursor(scans.scannedAt, scans.id, cursor),
          ),
        )
        .orderBy(desc(scans.scannedAt), desc(scans.id))
        .limit(limit + 1);
      const p = page(rows, limit, (r) => timeKey(r.scannedAt, r.id));
      const [sum] = await db
        .select({
          added: sql<number>`count(*) filter (where ${scans.result} = 'added')::int`,
          points: sql<number>`coalesce(sum(${scans.points}) filter (where ${scans.result} = 'added'), 0)::int`,
          failed: sql<number>`count(*) filter (where ${scans.result} <> 'added')::int`,
        })
        .from(scans)
        .where(where);
      return {
        summary: { added: sum.added, points: sum.points, waiting: 0, failed: sum.failed },
        nextCursor: p.nextCursor,
        rows: p.rows.map((r) => ({
          id: String(r.id),
          code: r.code ?? r.codeRaw.slice(0, 20),
          at: r.scannedAt.toISOString(),
          day: r.day,
          source: r.source,
          value: r.points,
          status: r.result === 'added' ? 'added' : 'failed',
          reason: r.result === 'added' ? undefined : REASON[r.result],
        })),
      };
    },
  );
};

export default routes;
