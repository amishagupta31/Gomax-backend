import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { users, withdrawals } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { post } from '../lib/ledger.js';
import { notify } from '../lib/notify.js';
import { getSettings } from '../lib/settings.js';
import type { FileStore } from '../lib/storage.js';
import { istMonth } from '../lib/time.js';
import { UPI_RE } from '../lib/kyc.js';
import { requireUser } from '../plugins/auth.js';
import { idCursor, page, PageQuery } from '../lib/page.js';
import { kycState } from '../services/account.js';

// B3 Withdraw. The request locks the points; reject / fail returns them (D4).
// Limits come from Settings: 500 min, ₹5,000 a request, ₹15,000 a month.
export const COUNTS_TO_MONTH = ['requested', 'approved', 'held', 'paid'] as const;

export async function withdrawalView(w: typeof withdrawals.$inferSelect, store: FileStore) {
  return {
    id: `W-${w.id}`,
    amount: w.amount,
    upiId: w.upiId,
    upiName: w.upiName,
    status: w.status,
    reason: w.reason,
    requestedAt: w.createdAt.toISOString(),
    approvedAt: w.approvedAt?.toISOString() ?? null,
    paidAt: w.paidAt?.toISOString() ?? null,
    utr: w.utr,
    proofUrl: w.status === 'paid' && w.proofObject ? await store.signedGet(w.proofObject) : null,
  };
}

export const parseWithdrawalId = (id: string) => {
  const n = Number(id.replace(/^W-/i, ''));
  if (!Number.isInteger(n) || n <= 0) throw notFound('Withdrawal');
  return n;
};

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, store, now } = app.deps;

  app.post(
    '/withdrawals',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: z.object({
          amount: z.number().int().positive(),
          /** Defaults to the verified UPI on the account. */
          upiId: z.string().trim().max(60).optional(),
          /** Object name from POST /uploads (purpose upi_qr), if the user uploaded their QR. */
          upiQrObject: z.string().max(200).optional(),
        }),
      },
    },
    async (req) => {
      const t = now();
      const s = await getSettings(db);
      const k = await kycState(db, req.userId);
      if (!k.pan || !k.upi) throw badRequest('kyc_missing', 'Add PAN and UPI first');
      const upiId = req.body.upiId ?? k.upi.id;
      if (!UPI_RE.test(upiId)) throw badRequest('bad_upi', 'Check the UPI ID');
      if (req.body.upiQrObject && !req.body.upiQrObject.startsWith(`upi_qr/${req.userId}/`)) throw forbidden();
      const { amount } = req.body;
      if (amount < s.withdraw.minPoints) throw badRequest('below_min', `Withdraw from ${s.withdraw.minPoints} points`);
      if (amount > s.withdraw.maxPerRequest) throw badRequest('above_max', `Up to ₹${s.withdraw.maxPerRequest.toLocaleString('en-IN')} per request`);

      const w = await db.transaction(async (tx) => {
        const [u] = await tx.select().from(users).where(eq(users.id, req.userId)).for('update');
        if (u.cashHold) throw conflict('under_check', 'Your account is under check. Call GoMax helpline 92158 44410.');
        if (u.points < amount) throw conflict('insufficient_balance', 'Not enough points');
        const month = istMonth(t);
        const [m] = await tx
          .select({ total: sql<number>`coalesce(sum(${withdrawals.amount}), 0)::int` })
          .from(withdrawals)
          .where(and(eq(withdrawals.userId, u.id), eq(withdrawals.monthKey, month), inArray(withdrawals.status, [...COUNTS_TO_MONTH])));
        if (m.total + amount > s.withdraw.maxPerMonth) {
          throw badRequest('month_limit', `Up to ₹${s.withdraw.maxPerMonth.toLocaleString('en-IN')} a month`, { leftThisMonth: Math.max(0, s.withdraw.maxPerMonth - m.total) });
        }
        const upiName = upiId === k.upi!.id ? k.upi!.name : null;
        const [row] = await tx
          .insert(withdrawals)
          .values({ userId: u.id, amount, upiId, upiName, upiQrObject: req.body.upiQrObject ?? null, monthKey: month, nameDiffers: upiName ? false : true, createdAt: t })
          .returning();
        await post(tx, { at: t, userId: u.id, wallet: 'points', kind: 'withdraw', amount: -amount, title: 'Withdraw request', sub: `W-${row.id} · to ${upiId}`, ref: `withdrawal:${row.id}` });
        await notify(tx, u.id, { kind: 'money', title: `₹${amount.toLocaleString('en-IN')} withdraw requested`, body: 'GoMax will pay you in 24–48 hrs', art: 'credit-card', link: { route: 'Withdraw' } });
        return row;
      });
      return withdrawalView(w, store);
    },
  );

  app.get('/withdrawals', { preHandler: requireUser, schema: { querystring: z.object(PageQuery) } }, async (req) => {
    const rows = await db
      .select()
      .from(withdrawals)
      .where(and(eq(withdrawals.userId, req.userId), idCursor(withdrawals.id, req.query.cursor)))
      .orderBy(desc(withdrawals.id))
      .limit(req.query.limit + 1);
    const p = page(rows, req.query.limit, (r) => String(r.id));
    return { withdrawals: await Promise.all(p.rows.map((w) => withdrawalView(w, store))), nextCursor: p.nextCursor };
  });

  app.get('/withdrawals/:id', { preHandler: requireUser, schema: { params: z.object({ id: z.string() }) } }, async (req) => {
    const [w] = await db
      .select()
      .from(withdrawals)
      .where(and(eq(withdrawals.id, parseWithdrawalId(req.params.id)), eq(withdrawals.userId, req.userId)));
    if (!w) throw notFound('Withdrawal');
    return withdrawalView(w, store);
  });
};

export default routes;
