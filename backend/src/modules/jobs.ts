import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { scratchCards, scans, streakPhotos, userKyc, users, waOutbox, withdrawals } from '../db/schema.js';
import { safeEqual } from '../lib/crypto.js';
import { notFound, unauthorized } from '../lib/errors.js';
import { queueWhatsApp } from '../lib/notify.js';
import { getSettings } from '../lib/settings.js';
import { addDays, istDay } from '../lib/time.js';
import type { Deps } from '../app.js';
import { sendPayouts, syncPayouts } from '../services/payouts.js';

// Cloud Scheduler → POST /internal/jobs/<name> with an OIDC token from the
// scheduler service account (infra/terraform/scheduler.tf).
async function authorize(req: FastifyRequest, deps: Deps) {
  const secret = req.headers['x-jobs-secret'];
  if (deps.config.JOBS_SECRET && typeof secret === 'string' && safeEqual(secret, deps.config.JOBS_SECRET)) return;
  const auth = req.headers.authorization;
  if (deps.verifyJobToken && auth?.startsWith('Bearer ') && (await deps.verifyJobToken(auth.slice(7)))) return;
  throw unauthorized('Not allowed');
}

export const JOBS: Record<string, (d: Deps) => Promise<Record<string, number>>> = {
  /** Every minute: send queued WhatsApp messages, retry with backoff (1, 2, 4, 8 min). */
  async outbox({ db, wa, now }) {
    const t = now();
    let sent = 0;
    let failed = 0;
    // SKIP LOCKED: overlapping runs never send the same message twice.
    const batch = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(waOutbox)
        .where(and(eq(waOutbox.status, 'pending'), lte(waOutbox.sendAfter, t)))
        .orderBy(waOutbox.id)
        .limit(50)
        .for('update', { skipLocked: true });
      if (rows.length) {
        await tx.update(waOutbox).set({ sendAfter: new Date(t.getTime() + 5 * 60_000) }).where(inArray(waOutbox.id, rows.map((r) => r.id)));
      }
      return rows;
    });
    for (const m of batch) {
      try {
        await wa.send(m.toMobile, m.template, m.vars);
        await db.update(waOutbox).set({ status: 'sent', sentAt: now(), attempts: m.attempts + 1 }).where(eq(waOutbox.id, m.id));
        sent++;
      } catch (e) {
        const attempts = m.attempts + 1;
        await db
          .update(waOutbox)
          .set({
            attempts,
            lastError: String((e as Error).message).slice(0, 500),
            status: attempts >= 5 ? 'failed' : 'pending',
            sendAfter: new Date(t.getTime() + 2 ** (attempts - 1) * 60_000),
          })
          .where(eq(waOutbox.id, m.id));
        failed++;
      }
    }
    return { sent, failed };
  },

  /** 9 pm IST: one "today: N coupons" summary per active scanner (D8 — not one per scan). */
  async 'daily-summary'({ db, now }) {
    const t = now();
    const s = await getSettings(db);
    const rows = await db
      .select({ userId: scans.userId, n: sql<number>`count(*)::int`, pts: sql<number>`sum(${scans.points})::int` })
      .from(scans)
      .where(and(eq(scans.day, istDay(t)), eq(scans.result, 'added')))
      .groupBy(scans.userId);
    for (const r of rows) {
      const [u] = await db.select({ points: users.points, runs: users.runs }).from(users).where(eq(users.id, r.userId));
      const left = Math.max(0, s.scratch.couponsPerCard - r.n);
      await queueWhatsApp(db, r.userId, 'daily_summary', {
        count: String(r.n),
        points: String(r.pts),
        pointsBalance: String(u.points),
        runsBalance: String(u.runs),
        left: left ? `Scan ${left} more today to get a scratch card.` : 'You got today’s scratch card.',
      });
    }
    return { queued: rows.length };
  },

  /** 00:05 IST: tell people whose streak just broke (C4-14). */
  async 'streak-check'({ db, now }) {
    const yesterday = addDays(istDay(now()), -1);
    const dayBefore = addDays(yesterday, -1);
    const broke = await db
      .select({ userId: streakPhotos.userId })
      .from(streakPhotos)
      .where(
        and(
          eq(streakPhotos.day, dayBefore),
          sql`${streakPhotos.status} <> 'rejected'`,
          sql`not exists (select 1 from ${streakPhotos} p2 where p2.user_id = ${streakPhotos.userId} and p2.day = ${yesterday} and p2.status <> 'rejected')`,
        ),
      );
    for (const b of broke) await queueWhatsApp(db, b.userId, 'streak_missed', {});
    return { notified: broke.length };
  },

  /** Hourly: expire unopened scratch cards (7 days) and release stale payout locks. */
  async housekeeping({ db, now }) {
    const t = now();
    const cards = await db.update(scratchCards).set({ status: 'expired' }).where(and(eq(scratchCards.status, 'new'), lte(scratchCards.expiresAt, t))).returning({ id: scratchCards.id });
    const locks = await db.update(withdrawals).set({ lockedBy: null, lockedUntil: null }).where(lte(withdrawals.lockedUntil, t)).returning({ id: withdrawals.id });
    return { expiredCards: cards.length, releasedLocks: locks.length };
  },

  /** PAYOUT_MODE=razorpayx: send approved withdrawals to RazorpayX, then check ones still in flight. */
  async payouts({ db, razorpay, config, now }): Promise<Record<string, number>> {
    if (config.PAYOUT_MODE !== 'razorpayx' || !razorpay) return { skipped: 1 };
    const sent = await sendPayouts(db, razorpay, now());
    const synced = await syncPayouts(db, razorpay, now());
    return { sent: sent.sent, sendErrors: sent.failed, checked: synced.checked, updated: synced.updated };
  },

  /** Weekly: points ready to withdraw but no UPI yet (C4-10). */
  async 'kyc-reminder'({ db }) {
    const s = await getSettings(db);
    const rows = await db
      .select({ id: users.id, points: users.points })
      .from(users)
      .leftJoin(userKyc, eq(userKyc.userId, users.id))
      .where(and(gt(users.points, s.withdraw.minPoints - 1), eq(users.status, 'active'), isNull(userKyc.upiVerifiedAt)));
    for (const r of rows) await queueWhatsApp(db, r.id, 'kyc_reminder', { points: String(r.points) });
    return { queued: rows.length };
  },
};

const routes: FastifyPluginAsync = async (app) => {
  app.post('/:job', async (req) => {
    await authorize(req, app.deps);
    const job = JOBS[(req.params as { job: string }).job];
    if (!job) throw notFound('Job');
    return { ok: true, ...(await job(app.deps)) };
  });
};

export default routes;
