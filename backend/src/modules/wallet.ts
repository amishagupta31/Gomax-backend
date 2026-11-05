import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ledger, withdrawals } from '../db/schema.js';
import { getSettings } from '../lib/settings.js';
import { idCursor, page, PageQuery } from '../lib/page.js';
import { addDays, istDay, istDayStart, istMonth } from '../lib/time.js';
import { requireUser } from '../plugins/auth.js';
import { getUser, kycState } from '../services/account.js';

// B2 Wallet + B4 History. App filter chips map onto ledger kinds.
type Kind = (typeof ledger.$inferSelect)['kind'];
export const APP_KIND: Record<Kind, 'scan' | 'withdraw' | 'bonus' | 'games' | 'invite' | 'gifts'> = {
  scan: 'scan',
  bonus: 'bonus',
  adjustment: 'bonus',
  withdraw: 'withdraw',
  withdraw_refund: 'withdraw',
  spin: 'games',
  scratch: 'games',
  challenge: 'games',
  quest: 'games',
  streak: 'games',
  invite: 'invite',
  referral: 'invite',
  gift: 'gifts',
  gift_refund: 'gifts',
};
const KINDS_FOR = (k: string) => (Object.keys(APP_KIND) as Kind[]).filter((x) => APP_KIND[x] === k);

/** IST date range for the B4-02 filter. */
export function rangeBounds(range: string, now: Date, from?: string, to?: string) {
  const today = istDay(now);
  switch (range) {
    case 'today':
      return { from: istDayStart(today), to: istDayStart(addDays(today, 1)) };
    case '7d':
      return { from: istDayStart(addDays(today, -6)), to: istDayStart(addDays(today, 1)) };
    case 'lastMonth': {
      const m = istMonth(now);
      const first = `${m}-01`;
      const prev = istMonth(istDayStart(addDays(first, -1)));
      return { from: istDayStart(`${prev}-01`), to: istDayStart(first) };
    }
    case 'custom':
      return { from: istDayStart(from ?? today), to: istDayStart(addDays(to ?? today, 1)) };
    default: // month
      return { from: istDayStart(`${istMonth(now)}-01`), to: istDayStart(addDays(today, 1)) };
  }
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, now } = app.deps;

  app.get('/wallet', { preHandler: requireUser }, async (req) => {
    const u = await getUser(db, req.userId);
    const s = await getSettings(db);
    const k = await kycState(db, u.id);
    const [open] = await db
      .select({ id: withdrawals.id, amount: withdrawals.amount, status: withdrawals.status })
      .from(withdrawals)
      .where(and(eq(withdrawals.userId, u.id), inArray(withdrawals.status, ['requested', 'approved', 'held'])))
      .orderBy(desc(withdrawals.createdAt))
      .limit(1);
    const blockers = [
      u.points < s.withdraw.minPoints ? 'min_points' : null,
      !k.pan ? 'pan_missing' : null,
      !k.upi ? 'upi_missing' : null,
      u.cashHold ? 'under_check' : null,
    ].filter(Boolean);
    return {
      points: u.points,
      runs: u.runs,
      lifetimePoints: u.lifetimePoints,
      rupeesPerPoint: 1,
      withdraw: { ...s.withdraw, canWithdraw: blockers.length === 0, blockers, pointsToMin: Math.max(0, s.withdraw.minPoints - u.points) },
      upi: k.upi,
      openWithdrawal: open ? { id: `W-${open.id}`, amount: open.amount, status: open.status } : null,
    };
  });

  app.get(
    '/ledger',
    {
      preHandler: requireUser,
      schema: {
        querystring: z.object({
          wallet: z.enum(['points', 'runs']).default('points'),
          kind: z.enum(['all', 'scan', 'withdraw', 'bonus', 'games', 'invite', 'gifts']).default('all'),
          range: z.enum(['today', '7d', 'month', 'lastMonth', 'custom']).default('month'),
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          ...PageQuery,
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const b = rangeBounds(q.range, now(), q.from, q.to);
      const where = and(
        eq(ledger.userId, req.userId),
        eq(ledger.wallet, q.wallet),
        gte(ledger.createdAt, b.from),
        lt(ledger.createdAt, b.to),
        q.kind === 'all' ? undefined : inArray(ledger.kind, KINDS_FOR(q.kind)),
      );
      const rows = await db
        .select()
        .from(ledger)
        .where(and(where, idCursor(ledger.id, q.cursor)))
        .orderBy(desc(ledger.id))
        .limit(q.limit + 1);
      const p = page(rows, q.limit, (r) => String(r.id));
      const [tot] = await db
        .select({
          earned: sql<number>`coalesce(sum(${ledger.amount}) filter (where ${ledger.amount} > 0), 0)::int`,
          spent: sql<number>`coalesce(-sum(${ledger.amount}) filter (where ${ledger.amount} < 0), 0)::int`,
        })
        .from(ledger)
        .where(where);
      return {
        totals: tot,
        nextCursor: p.nextCursor,
        rows: p.rows.map((r) => ({
          id: String(r.id),
          wallet: r.wallet,
          kind: APP_KIND[r.kind],
          title: r.title,
          sub: r.sub,
          amount: r.amount,
          at: r.createdAt.toISOString(),
        })),
      };
    },
  );
};

export default routes;
