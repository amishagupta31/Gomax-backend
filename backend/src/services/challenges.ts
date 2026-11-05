import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { challengeClaims, challenges, couponBatches, coupons, scans, users } from '../db/schema.js';
import { istWeek } from '../lib/time.js';
import { streakState } from './streak.js';

export type Challenge = typeof challenges.$inferSelect;

// The catalogue changes rarely (Admin → Challenges): keep it 30 s per instance.
const CATALOG_MS = 30_000;
const catalogCache = new WeakMap<object, { at: number; rows: Challenge[] }>();

export async function catalog(db: Db) {
  const hit = catalogCache.get(db);
  if (hit && Date.now() - hit.at < CATALOG_MS) return hit.rows;
  const rows = await db.select().from(challenges).orderBy(challenges.sort);
  catalogCache.set(db, { at: Date.now(), rows });
  return rows;
}

export const clearCatalogCache = (db: Db) => catalogCache.delete(db);

/** Home's single "active challenge": first live, unclaimed one — a coupon challenge if there is one. */
export async function activeChallenge(db: Db, userId: string, now: Date) {
  const all = (await catalog(db)).filter((c) => isLive(c, now));
  if (!all.length) return null;
  const claims = await db.select({ id: challengeClaims.challengeId, key: challengeClaims.periodKey }).from(challengeClaims).where(eq(challengeClaims.userId, userId));
  const open = all.filter((c) => !claims.some((k) => k.id === c.id && k.key === windowFor(c, now).key));
  const ch = open.find((c) => c.kind === 'scan_count') ?? open[0];
  if (!ch) return null;
  const progress = await progressFor(db, userId, ch, now);
  return view(ch, Math.min(progress, ch.goal), false, windowFor(ch, now).to);
}

/** The window a challenge counts in, and the key a claim is stored under. */
export function windowFor(ch: Challenge, now: Date) {
  if (ch.period === 'week') {
    const w = istWeek(now);
    return { key: w.key, from: w.start, to: w.end };
  }
  return { key: 'range', from: ch.startsAt ?? new Date(0), to: ch.endsAt ?? new Date('2100-01-01') };
}

export const isLive = (ch: Challenge, now: Date) =>
  ch.active && (!ch.startsAt || ch.startsAt <= now) && (!ch.endsAt || ch.endsAt > now);

export async function progressFor(db: Db, userId: string, ch: Challenge, now: Date): Promise<number> {
  const { from, to } = windowFor(ch, now);
  const inWindow = and(gte(scans.scannedAt, from), lt(scans.scannedAt, to));
  switch (ch.kind) {
    case 'scan_count': {
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(scans)
        .where(and(eq(scans.userId, userId), eq(scans.result, 'added'), inWindow));
      return r.n;
    }
    case 'ultra_scan_count': {
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(scans)
        .innerJoin(coupons, eq(coupons.id, scans.couponId))
        .innerJoin(couponBatches, eq(couponBatches.id, coupons.batchId))
        .where(and(eq(scans.userId, userId), eq(scans.result, 'added'), eq(couponBatches.line, 'ultra'), inWindow));
      return r.n;
    }
    case 'invite_count': {
      // "Invite 2 applicators who scan": friends whose 1st coupon falls in the window.
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.referredBy, userId), isNotNull(users.firstCouponAt), gte(users.firstCouponAt, from), lt(users.firstCouponAt, to)));
      return r.n;
    }
    case 'streak_days':
      return (await streakState(db, userId, now)).completed;
  }
}

export async function challengesFor(db: Db, userId: string, now: Date) {
  const all = await catalog(db);
  const claims = await db.select().from(challengeClaims).where(eq(challengeClaims.userId, userId));
  const live = [];
  for (const ch of all.filter((c) => isLive(c, now))) {
    const w = windowFor(ch, now);
    const progress = await progressFor(db, userId, ch, now);
    const claimed = claims.some((c) => c.challengeId === ch.id && c.periodKey === w.key);
    live.push(view(ch, Math.min(progress, ch.goal), claimed, w.to));
  }
  const doneIds = [...new Set(claims.map((c) => c.challengeId))];
  const doneRows = all.filter((c) => doneIds.includes(c.id));
  const done = claims
    .sort((a, b) => b.claimedAt.getTime() - a.claimedAt.getTime())
    .map((c) => {
      const ch = doneRows.find((d) => d.id === c.challengeId)!;
      return { ...view(ch, ch.goal, true, null), claimId: c.id, wonAt: c.claimedAt.toISOString(), runsWon: c.runs };
    });
  return { live: live.filter((c) => !c.claimed), done };
}

export function view(ch: Challenge, progress: number, claimed: boolean, endsAt: Date | null) {
  return {
    id: ch.id,
    kind: ch.kind,
    tag: ch.tag,
    tone: ch.tone,
    title: ch.title,
    shortTitle: ch.shortTitle,
    art: ch.art,
    goal: ch.goal,
    progress,
    rewardRuns: ch.rewardRuns,
    rewardScratchCards: ch.rewardScratchCards,
    bonusText: ch.bonusText,
    milestones: ch.milestones.map((m) => ({ ...m, reached: progress >= m.at })),
    endsAt: endsAt && endsAt.getFullYear() < 2100 ? endsAt.toISOString() : null,
    complete: progress >= ch.goal,
    claimed,
  };
}
