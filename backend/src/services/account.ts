import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { scans, scratchCards, spins, userKyc, users } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { rankFor } from '../lib/ranks.js';
import type { Settings } from '../lib/settings.js';
import { istDay, secondsToIstMidnight } from '../lib/time.js';

export async function getUser(db: Db, userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) throw notFound('Account');
  return u;
}

export async function todayAdded(db: Db, userId: string, now: Date) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int`, pts: sql<number>`coalesce(sum(${scans.points}), 0)::int` })
    .from(scans)
    .where(and(eq(scans.userId, userId), eq(scans.result, 'added'), eq(scans.day, istDay(now))));
  return { count: r.n, points: r.pts };
}

export async function spinState(db: Db, userId: string, lifetimePoints: number, s: Settings, now: Date) {
  const total = rankFor(lifetimePoints, s.ranks).current.spins;
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(spins)
    .where(and(eq(spins.userId, userId), eq(spins.day, istDay(now))));
  return { total, used: r.n, left: Math.max(0, total - r.n), resetsInSec: secondsToIstMidnight(now) };
}

export async function kycState(db: Db, userId: string) {
  const [k] = await db.select().from(userKyc).where(eq(userKyc.userId, userId));
  return {
    pan: k?.panVerifiedAt ? { masked: k.panMasked!, name: k.panName! } : null,
    upi: k?.upiVerifiedAt ? { id: k.upiId!, name: k.upiName!, matchesPan: k.upiMatchesPan ?? false } : null,
  };
}

export async function readyScratchCards(db: Db, userId: string, now: Date) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scratchCards)
    .where(and(eq(scratchCards.userId, userId), eq(scratchCards.status, 'new'), gt(scratchCards.expiresAt, now)));
  return r.n;
}

/** Home counters in one round trip: today's coupons, spins used, ready scratch cards, PAN / UPI. */
export async function homeCounts(db: Db, userId: string, now: Date) {
  const day = istDay(now);
  const [r] = await db
    .select({
      coupons: sql<number>`(select count(*)::int from ${scans} where ${scans.userId} = ${userId} and ${scans.result} = 'added' and ${scans.day} = ${day})`,
      points: sql<number>`(select coalesce(sum(${scans.points}), 0)::int from ${scans} where ${scans.userId} = ${userId} and ${scans.result} = 'added' and ${scans.day} = ${day})`,
      spinsUsed: sql<number>`(select count(*)::int from ${spins} where ${spins.userId} = ${userId} and ${spins.day} = ${day})`,
      cards: sql<number>`(select count(*)::int from ${scratchCards} where ${scratchCards.userId} = ${userId} and ${scratchCards.status} = 'new' and ${scratchCards.expiresAt} > ${now})`,
      panMasked: userKyc.panMasked,
      panName: userKyc.panName,
      panVerifiedAt: userKyc.panVerifiedAt,
      upiId: userKyc.upiId,
      upiName: userKyc.upiName,
      upiMatchesPan: userKyc.upiMatchesPan,
      upiVerifiedAt: userKyc.upiVerifiedAt,
    })
    .from(users)
    .leftJoin(userKyc, eq(userKyc.userId, users.id))
    .where(eq(users.id, userId));
  return {
    today: { count: r.coupons, points: r.points },
    spinsUsed: r.spinsUsed,
    cards: r.cards,
    kyc: {
      pan: r.panVerifiedAt ? { masked: r.panMasked!, name: r.panName! } : null,
      upi: r.upiVerifiedAt ? { id: r.upiId!, name: r.upiName!, matchesPan: r.upiMatchesPan ?? false } : null,
    },
  };
}

export function rankView(lifetimePoints: number, s: Settings) {
  const r = rankFor(lifetimePoints, s.ranks);
  return {
    id: r.current.id,
    name: r.current.name,
    spinsPerDay: r.current.spins,
    runsBoostPct: r.current.runsBoostPct,
    next: r.next ? { id: r.next.id, name: r.next.name, min: r.next.min, pointsToGo: r.toNext } : null,
    ladder: s.ranks.map((x) => ({ id: x.id, name: x.name, min: x.min, spinsPerDay: x.spins, runsBoostPct: x.runsBoostPct })),
  };
}
