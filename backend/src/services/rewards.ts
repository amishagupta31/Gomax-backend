import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { questClaims, referralCredits, scratchCards, users } from '../db/schema.js';
import { post } from '../lib/ledger.js';
import { notify, queueWhatsApp } from '../lib/notify.js';
import { boostRuns, rankFor } from '../lib/ranks.js';
import { pickWeighted, type Settings } from '../lib/settings.js';
import { istDay, istMonth } from '../lib/time.js';

/** Daily quest reward (C2-08 "Today's quests"), once per quest per IST day. */
export async function awardQuest(db: Db, s: Settings, userId: string, quest: 'scan' | 'invite' | 'photo', now: Date, opts: { paidElsewhere?: number } = {}) {
  const base = opts.paidElsewhere ?? s.quests[quest];
  if (!base) return 0;
  const [u] = await db.select({ lp: users.lifetimePoints }).from(users).where(eq(users.id, userId));
  const runs = opts.paidElsewhere ?? boostRuns(base, rankFor(u.lp, s.ranks).current);
  const inserted = await db
    .insert(questClaims)
    .values({ userId, day: istDay(now), quest, runs })
    .onConflictDoNothing()
    .returning({ id: questClaims.id });
  if (!inserted.length || opts.paidElsewhere != null) return 0;
  const titles = { scan: 'Quest: scan 1 coupon', invite: 'Quest: invite 1 applicator', photo: "Quest: today's work photo" };
  await post(db, { at: now, userId, wallet: 'runs', kind: 'quest', amount: runs, title: titles[quest], sub: 'Daily quest' });
  return runs;
}

/** Scratch card with the prize fixed now, server-side (C2 notes). */
export async function issueScratchCard(db: Db, s: Settings, userId: string, source: string, now: Date) {
  const prize = pickWeighted(s.scratch.prizes);
  const rows = await db
    .insert(scratchCards)
    .values({
      userId,
      earnedDay: istDay(now),
      source,
      prizeKind: prize.kind,
      prizeAmount: prize.amount,
      expiresAt: new Date(now.getTime() + s.scratch.expiryDays * 86_400_000),
    })
    .onConflictDoNothing()
    .returning({ id: scratchCards.id });
  return rows[0]?.id ?? null;
}

/** Referral runs earned this IST month (all levels + bonus), for the monthly cap. */
async function monthTotal(db: Db, earnerId: string, now: Date) {
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(${referralCredits.runs}), 0)::int` })
    .from(referralCredits)
    .where(and(eq(referralCredits.earnerId, earnerId), eq(referralCredits.monthKey, istMonth(now))));
  return r.n;
}

/**
 * D6 referral rewards, paid in RUNS:
 *  - first coupon of a friend → +50 runs to the direct inviter (level 0);
 *  - every scan → each of L1–L4 above the scanner earns 10% of the points.
 * Capped at 200 runs a month per earner; nothing is paid when the earner
 * and the scanner use the same phone.
 */
export async function payReferrals(
  db: Db,
  s: Settings,
  scanner: { id: string; name: string; referredBy: string | null; lastDeviceId: string | null },
  scanId: number,
  points: number,
  firstCoupon: boolean,
  now: Date,
) {
  const cfg = s.referral;
  let parentId = scanner.referredBy;
  for (let level = 1; level <= cfg.levels && parentId; level++) {
    const [p] = await db
      .select({ id: users.id, referredBy: users.referredBy, device: users.lastDeviceId, status: users.status, inviteCode: users.inviteCode })
      .from(users)
      .where(eq(users.id, parentId));
    if (!p) break;
    const sameDevice = Boolean(p.device && p.device === scanner.lastDeviceId);
    if (p.status === 'active' && !sameDevice) {
      const room = Math.max(0, cfg.monthlyCapRuns - (await monthTotal(db, p.id, now)));
      const pay = async (lvl: number, want: number, title: string, sub: string) => {
        const runs = Math.min(room, want);
        if (runs <= 0) return 0;
        await db.insert(referralCredits).values({ earnerId: p.id, fromUserId: scanner.id, level: lvl, scanId, runs, monthKey: istMonth(now) });
        await post(db, { at: now, userId: p.id, wallet: 'runs', kind: lvl === 0 ? 'invite' : 'referral', amount: runs, title, sub });
        return runs;
      };
      if (level === 1 && firstCoupon && cfg.firstCouponBonusRuns > 0) {
        const got = await pay(0, cfg.firstCouponBonusRuns, `${scanner.name.split(' ')[0]} joined with your code`, 'Invite bonus');
        if (got > 0) {
          await notify(db, p.id, { kind: 'invite', title: 'Friend joined!', body: `${scanner.name} joined GoMax with your code · +${got} runs`, art: 'handshake', link: { route: 'InviteEarn' } });
          await queueWhatsApp(db, p.id, 'friend_joined', { friend: scanner.name.split(' ')[0], code: p.inviteCode, runs: String(got) });
          // "Invite 1 applicator" quest = this same +50, so it is only marked done.
          await awardQuest(db, s, p.id, 'invite', now, { paidElsewhere: got });
        }
      }
      const share = Math.floor((points * cfg.levelSharePct) / 100);
      const roomAfter = Math.max(0, cfg.monthlyCapRuns - (await monthTotal(db, p.id, now)));
      if (share > 0 && roomAfter > 0) {
        const runs = Math.min(roomAfter, share);
        await db.insert(referralCredits).values({ earnerId: p.id, fromUserId: scanner.id, level, scanId, runs, monthKey: istMonth(now) });
        await post(db, { at: now, userId: p.id, wallet: 'runs', kind: 'referral', amount: runs, title: 'Team bonus', sub: 'From people who joined with your code' });
      }
    }
    parentId = p.referredBy;
  }
}
