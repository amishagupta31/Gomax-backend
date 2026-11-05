import { and, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { challengeClaims, challenges, ledger, questClaims, scratchCards, spins, streakPhotos, streakRewards, users } from '../db/schema.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { post } from '../lib/ledger.js';
import { notify, queueWhatsApp } from '../lib/notify.js';
import { boostRuns, rankFor } from '../lib/ranks.js';
import { getSettings, pickWeighted } from '../lib/settings.js';
import { istDay, secondsToIstMidnight } from '../lib/time.js';
import { requireUser } from '../plugins/auth.js';
import { getUser, spinState, todayAdded } from '../services/account.js';
import { challengesFor, isLive, progressFor, view, windowFor } from '../services/challenges.js';
import { awardQuest, issueScratchCard } from '../services/rewards.js';
import { streakState } from '../services/streak.js';
import { rangeBounds } from './wallet.js';
import { idCursor, page, PageQuery } from '../lib/page.js';

/** C2-01 wheel, clockwise from the pointer. 100 is shown but never drawn (D7). */
export const WHEEL = [10, 20, 5, 50, 10, 100, 5, 20];

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, now } = app.deps;
  app.addHook('preHandler', requireUser);

  // ── Spin (C2-01 … C2-03) ───────────────────────────────────────────────
  app.get('/spins/today', async (req) => {
    const u = await getUser(db, req.userId);
    return { ...(await spinState(db, u.id, u.lifetimePoints, await getSettings(db), now())), wheel: WHEEL };
  });

  app.post('/spins', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const t = now();
    const s = await getSettings(db);
    return db.transaction(async (tx) => {
      // Lock the user row so two taps can't both use the last spin.
      const [u] = await tx.select().from(users).where(eq(users.id, req.userId)).for('update');
      const st = await spinState(tx, u.id, u.lifetimePoints, s, t);
      if (st.left <= 0) throw conflict('no_spins_left', 'No spins left today', { resetsInSec: secondsToIstMidnight(t) });
      // The server decides; 100 is filtered out here as well as in Settings.
      const odds = s.spinOdds.filter((o) => o.runs !== 100 && o.weight > 0);
      const prize = pickWeighted(odds).runs;
      await tx.insert(spins).values({ userId: u.id, day: istDay(t), prizeRuns: prize });
      const runs = await post(tx, { at: t, userId: u.id, wallet: 'runs', kind: 'spin', amount: prize, title: 'Spin the wheel', sub: 'Free spin' });
      return { prizeRuns: prize, spinsLeft: st.left - 1, spinsTotal: st.total, runs };
    });
  });

  // ── Scratch cards (C2-04 … C2-07) ──────────────────────────────────────
  app.get('/scratch-cards', async (req) => {
    const t = now();
    const s = await getSettings(db);
    await db
      .update(scratchCards)
      .set({ status: 'expired' })
      .where(and(eq(scratchCards.userId, req.userId), eq(scratchCards.status, 'new'), lte(scratchCards.expiresAt, t)));
    const rows = await db.select().from(scratchCards).where(eq(scratchCards.userId, req.userId)).orderBy(desc(scratchCards.createdAt)).limit(60);
    const today = await todayAdded(db, req.userId, t);
    const earnedToday = rows.some((r) => r.earnedDay === istDay(t) && r.source === 'coupons');
    const won = rows.filter((r) => r.status === 'revealed');
    return {
      cards: rows.map((r) => ({
        id: r.id,
        state: r.status === 'revealed' ? 'won' : r.status,
        earnedDay: r.earnedDay,
        source: r.source,
        expiresAt: r.expiresAt.toISOString(),
        prize: r.status === 'revealed' ? { kind: r.prizeKind, amount: r.prizeAmount } : null,
      })),
      today: { coupons: today.count, perCard: s.scratch.couponsPerCard, earned: earnedToday },
      won: {
        runs: won.filter((r) => r.prizeKind === 'runs').reduce((a, r) => a + r.prizeAmount, 0),
        points: won.filter((r) => r.prizeKind === 'points').reduce((a, r) => a + r.prizeAmount, 0),
      },
    };
  });

  app.post('/scratch-cards/:id/reveal', { schema: { params: z.object({ id: z.uuid() }) } }, async (req) => {
    const t = now();
    return db.transaction(async (tx) => {
      const [c] = await tx.select().from(scratchCards).where(eq(scratchCards.id, req.params.id)).for('update');
      if (!c || c.userId !== req.userId) throw notFound('Scratch card');
      const prize = { kind: c.prizeKind, amount: c.prizeAmount };
      if (c.status === 'revealed') return { prize, alreadyRevealed: true }; // idempotent
      if (c.status === 'expired' || c.expiresAt <= t) throw conflict('expired', 'This card has expired');
      await tx.update(scratchCards).set({ status: 'revealed', revealedAt: t }).where(eq(scratchCards.id, c.id));
      const balance = await post(tx, { at: t, userId: c.userId, wallet: c.prizeKind, kind: 'scratch', amount: c.prizeAmount, title: 'Scratch card', sub: c.source === 'coupons' ? '10 coupons' : 'Challenge reward' });
      return { prize, balance };
    });
  });

  // ── Challenges & quests (C2-08 … C2-12) ────────────────────────────────
  app.get('/challenges', async (req) => challengesFor(db, req.userId, now()));

  app.get('/challenges/:id', { schema: { params: z.object({ id: z.string().max(40) }) } }, async (req) => {
    const t = now();
    const [ch] = await db.select().from(challenges).where(eq(challenges.id, req.params.id));
    if (!ch) throw notFound('Challenge');
    const w = windowFor(ch, t);
    const progress = await progressFor(db, req.userId, ch, t);
    const [claim] = await db
      .select()
      .from(challengeClaims)
      .where(and(eq(challengeClaims.challengeId, ch.id), eq(challengeClaims.userId, req.userId), eq(challengeClaims.periodKey, w.key)));
    // C2-10 "34 applicators in Amritsar are on it" → everyone with progress this period.
    const [{ n: onIt }] = await db
      .select({ n: sql<number>`count(distinct ${ledger.userId})::int` })
      .from(ledger)
      .where(and(eq(ledger.kind, 'scan'), gte(ledger.createdAt, w.from), lt(ledger.createdAt, w.to)));
    return { ...view(ch, Math.min(progress, ch.goal), Boolean(claim), w.to), live: isLive(ch, t), participants: onIt };
  });

  app.post('/challenges/:id/claim', { schema: { params: z.object({ id: z.string().max(40) }) } }, async (req) => {
    const t = now();
    const s = await getSettings(db);
    return db.transaction(async (tx) => {
      const [ch] = await tx.select().from(challenges).where(eq(challenges.id, req.params.id));
      if (!ch || !isLive(ch, t)) throw notFound('Challenge');
      const progress = await progressFor(tx, req.userId, ch, t);
      if (progress < ch.goal) throw conflict('not_complete', `${ch.goal - progress} more to go`);
      const u = await getUser(tx, req.userId);
      const runs = boostRuns(ch.rewardRuns, rankFor(u.lifetimePoints, s.ranks).current);
      const w = windowFor(ch, t);
      const ins = await tx
        .insert(challengeClaims)
        .values({ challengeId: ch.id, userId: u.id, periodKey: w.key, runs })
        .onConflictDoNothing()
        .returning({ id: challengeClaims.id });
      if (!ins.length) throw conflict('already_claimed', 'Already collected');
      const balance = await post(tx, { at: t, userId: u.id, wallet: 'runs', kind: 'challenge', amount: runs, title: `${ch.tag} challenge won`, sub: ch.shortTitle });
      const cards: string[] = [];
      for (let i = 0; i < ch.rewardScratchCards; i++) {
        const id = await issueScratchCard(tx, s, u.id, `challenge:${ch.id}:${w.key}:${i}`, t);
        if (id) cards.push(id);
      }
      await notify(tx, u.id, { kind: 'games', title: `Challenge won · +${runs} runs`, body: ch.title, art: 'trophy', link: { route: 'ChallengeCompleted', params: { challengeId: ch.id } } });
      await queueWhatsApp(tx, u.id, 'challenge_won', { challenge: ch.title, runs: String(runs) });
      return { runs, scratchCards: cards, balance };
    });
  });

  app.get('/quests', async (req) => {
    const t = now();
    const s = await getSettings(db);
    const done = await db
      .select({ quest: questClaims.quest, runs: questClaims.runs })
      .from(questClaims)
      .where(and(eq(questClaims.userId, req.userId), eq(questClaims.day, istDay(t))));
    const q = (id: 'scan' | 'invite' | 'photo', title: string) => {
      const d = done.find((x) => x.quest === id);
      return { id, title, reward: d?.runs ?? s.quests[id], done: Boolean(d) };
    };
    return {
      resetsInSec: secondsToIstMidnight(t),
      quests: [q('scan', 'Scan 1 coupon'), q('invite', 'Invite 1 applicator'), q('photo', 'Today’s work photo')],
    };
  });

  // ── Photo streak (C2-13 … C2-15) ───────────────────────────────────────
  const streakView = async (userId: string, t: Date) => {
    const s = await getSettings(db);
    const st = await streakState(db, userId, t);
    const rewards = s.streak.rewards.map((r) => ({ ...r, reached: st.completed >= r.days }));
    const next = rewards.find((r) => !r.reached) ?? null;
    return { ...st, rewards, next: next ? { days: next.days, runs: next.runs, daysLeft: next.days - st.completed } : null };
  };

  app.get('/streak', async (req) => streakView(req.userId, now()));

  app.post(
    '/streak/photo',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: z.object({
          object: z.string().max(200),
          takenAt: z.iso.datetime(),
          lat: z.number().min(-90).max(90).optional(),
          lng: z.number().min(-180).max(180).optional(),
        }),
      },
    },
    async (req) => {
      const t = now();
      const b = req.body;
      if (!b.object.startsWith(`streak/${req.userId}/`)) throw forbidden();
      if (!(await app.deps.store.exists(b.object))) throw conflict('upload_missing', 'Photo upload did not finish. Try again.');
      const takenAt = new Date(b.takenAt);
      // Camera only, time-stamped: the photo must be from the last 15 minutes, today.
      if (Math.abs(t.getTime() - takenAt.getTime()) > 15 * 60_000 || istDay(takenAt) !== istDay(t)) {
        throw conflict('photo_too_old', 'Take a new photo with the camera');
      }
      const s = await getSettings(db);
      await db.transaction(async (tx) => {
        const ins = await tx
          .insert(streakPhotos)
          .values({ userId: req.userId, day: istDay(t), object: b.object, takenAt, lat: b.lat ?? null, lng: b.lng ?? null })
          .onConflictDoNothing()
          .returning({ id: streakPhotos.id });
        if (!ins.length) throw conflict('already_today', 'Today’s photo is already saved');
        await awardQuest(tx, s, req.userId, 'photo', t);
        const st = await streakState(tx, req.userId, t);
        const u = await getUser(tx, req.userId);
        for (const r of s.streak.rewards.filter((x) => x.days === st.completed && x.runs > 0)) {
          const runs = boostRuns(r.runs, rankFor(u.lifetimePoints, s.ranks).current);
          const got = await tx
            .insert(streakRewards)
            .values({ userId: u.id, milestone: r.days, runStart: st.runStart, runs })
            .onConflictDoNothing()
            .returning({ id: streakRewards.id });
          if (got.length) {
            await post(tx, { at: t, userId: u.id, wallet: 'runs', kind: 'streak', amount: runs, title: `Photo streak · ${r.days} days`, sub: 'Streak reward' });
            await notify(tx, u.id, { kind: 'games', title: `${r.days}-day streak! +${runs} runs`, art: 'fire', link: { route: 'PhotoStreak' } });
          }
        }
      });
      return streakView(req.userId, t);
    },
  );

  // ── Games history (C2-16) ──────────────────────────────────────────────
  app.get(
    '/games/history',
    {
      schema: {
        querystring: z.object({
          kind: z.enum(['all', 'spin', 'scratch', 'challenge']).default('all'),
          range: z.enum(['today', '7d', 'month', 'lastMonth']).default('7d'),
          ...PageQuery,
        }),
      },
    },
    async (req) => {
      const b = rangeBounds(req.query.range, now());
      const kinds = req.query.kind === 'all' ? (['spin', 'scratch', 'challenge'] as const) : ([req.query.kind] as const);
      const where = and(eq(ledger.userId, req.userId), inArray(ledger.kind, [...kinds]), gte(ledger.createdAt, b.from), lt(ledger.createdAt, b.to));
      const rows = await db
        .select()
        .from(ledger)
        .where(and(where, idCursor(ledger.id, req.query.cursor)))
        .orderBy(desc(ledger.id))
        .limit(req.query.limit + 1);
      const [tot] = await db
        .select({
          runs: sql<number>`coalesce(sum(${ledger.amount}) filter (where ${ledger.wallet} = 'runs'), 0)::int`,
          points: sql<number>`coalesce(sum(${ledger.amount}) filter (where ${ledger.wallet} = 'points'), 0)::int`,
        })
        .from(ledger)
        .where(where);
      const p = page(rows, req.query.limit, (r) => String(r.id));
      return {
        totals: tot,
        nextCursor: p.nextCursor,
        rows: p.rows.map((r) => ({ id: String(r.id), kind: r.kind, title: r.title, sub: r.sub, wallet: r.wallet, amount: r.amount, at: r.createdAt.toISOString() })),
      };
    },
  );
};

export default routes;
