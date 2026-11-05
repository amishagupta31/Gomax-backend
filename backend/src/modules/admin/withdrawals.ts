import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { userKyc, users, withdrawals } from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { namesMatch } from '../../lib/kyc.js';
import { post } from '../../lib/ledger.js';
import { notify, queueWhatsApp } from '../../lib/notify.js';
import { getSettings } from '../../lib/settings.js';
import { checkPin, requireStaff, staffActor } from '../../plugins/auth.js';
import { parseWithdrawalId } from '../withdrawals.js';
import { idCursor, page, PageQuery } from '../../lib/page.js';
import { uniqueViolation } from '../../lib/pgerrors.js';

// D4 queue + D11/M7 manual UPI payout:
// requested → (approve with PIN) → approved → (lock 15 min, pay in UPI app,
// upload screenshot + 12-digit UTR) → paid. Reject / fail returns the points.
const Id = z.object({ id: z.string() });
const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

async function load(db: Db, id: string) {
  const [w] = await db.select().from(withdrawals).where(eq(withdrawals.id, parseWithdrawalId(id))).for('update');
  if (!w) throw notFound('Withdrawal');
  return w;
}

async function refund(db: Db, w: typeof withdrawals.$inferSelect, title: string, at: Date) {
  await post(db, { at, userId: w.userId, wallet: 'points', kind: 'withdraw_refund', amount: w.amount, title, sub: `W-${w.id}`, ref: `withdrawal:${w.id}` });
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, now } = app.deps;
  const money = requireStaff('accounts');

  app.get(
    '/withdrawals',
    { preHandler: money, schema: { querystring: z.object({ status: z.enum(['requested', 'approved', 'paid', 'rejected', 'failed', 'held']).default('requested'), ...PageQuery }) } },
    async (req) => {
      const history = ['paid', 'rejected', 'failed'].includes(req.query.status);
      const rows = await db
        .select({ w: withdrawals, name: users.name, mobile: users.mobile, cashHold: users.cashHold, panName: userKyc.panName })
        .from(withdrawals)
        .innerJoin(users, eq(users.id, withdrawals.userId))
        .leftJoin(userKyc, eq(userKyc.userId, withdrawals.userId))
        // Work queues: oldest first, all of them. History (paid / rejected / failed): newest first, paged.
        .where(and(eq(withdrawals.status, req.query.status), history ? idCursor(withdrawals.id, req.query.cursor) : undefined))
        .orderBy(history ? desc(withdrawals.id) : asc(withdrawals.createdAt))
        .limit(history ? req.query.limit + 1 : 1000);
      const p = history ? page(rows, req.query.limit, (r) => String(r.w.id)) : { rows, nextCursor: null };
      const t = now();
      const [today] = await db
        .select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${withdrawals.amount}), 0)::int` })
        .from(withdrawals)
        .where(and(eq(withdrawals.status, 'paid'), gt(withdrawals.paidAt, new Date(t.getTime() - 86_400_000))));
      return {
        paidLast24h: today, // D11: compare with the bank's daily UPI limit
        nextCursor: p.nextCursor,
        rows: p.rows.map((r) => ({
          id: `W-${r.w.id}`,
          amount: r.w.amount,
          status: r.w.status,
          reason: r.w.reason,
          name: r.name,
          mobile: r.mobile,
          upiId: r.w.upiId,
          upiName: r.w.upiName,
          panName: r.panName,
          nameDiffers: r.w.nameDiffers || (r.w.upiName && r.panName ? !namesMatch(r.w.upiName, r.panName) : true),
          cashHold: r.cashHold,
          hasQr: Boolean(r.w.upiQrObject),
          lockedBy: r.w.lockedUntil && r.w.lockedUntil > t ? r.w.lockedBy : null,
          requestedAt: r.w.createdAt.toISOString(),
          approvedAt: r.w.approvedAt?.toISOString() ?? null,
          paidAt: r.w.paidAt?.toISOString() ?? null,
          utr: r.w.utr,
          payoutMode: r.w.payoutMode,
          payoutStatus: r.w.payoutStatus,
          payoutRef: r.w.payoutRef,
          payoutError: r.w.payoutError,
          // M7: opens the company UPI app pre-filled.
          upiIntent: `upi://pay?pa=${encodeURIComponent(r.w.upiId)}&pn=${encodeURIComponent(r.w.upiName ?? r.name)}&am=${r.w.amount}&tn=${encodeURIComponent(`GoMax W-${r.w.id}`)}`,
        })),
      };
    },
  );

  app.get('/withdrawals/:id/qr', { preHandler: money, schema: { params: Id } }, async (req) => {
    const w = await load(db, req.params.id);
    if (!w.upiQrObject) throw notFound('UPI QR');
    return { url: await app.deps.store.signedGet(w.upiQrObject) };
  });

  app.post('/withdrawals/:id/approve', { preHandler: money, schema: { params: Id, body: z.object({ pin: z.string().regex(/^\d{4}$/) }) } }, async (req) => {
    await checkPin(db, req.staff.id, req.body.pin, now());
    const t = now();
    return db.transaction(async (tx) => {
      const w = await load(tx, req.params.id);
      if (w.status !== 'requested' && w.status !== 'held') throw conflict('bad_status', `Already ${w.status}`);
      const [u] = await tx.select({ cashHold: users.cashHold }).from(users).where(eq(users.id, w.userId));
      if (u.cashHold && req.staff.role !== 'owner') throw conflict('under_check', 'Applicator is on hold — an owner must clear the flag first');
      await tx
        .update(withdrawals)
        .set({ status: 'approved', approvedBy: req.staff.id, approvedAt: t, reason: null, payoutMode: app.deps.config.PAYOUT_MODE, payoutStatus: null, payoutError: null, updatedAt: t })
        .where(eq(withdrawals.id, w.id));
      await queueWhatsApp(tx, w.userId, 'withdrawal_approved', { amount: rupees(w.amount) });
      await audit(tx, staffActor(req), 'withdrawal_approve', 'withdrawal', w.id, { status: w.status }, { status: 'approved' });
      return { ok: true };
    });
  });

  app.post('/withdrawals/:id/hold', { preHandler: money, schema: { params: Id, body: z.object({ reason: z.string().min(3).max(200) }) } }, async (req) => {
    const t = now();
    return db.transaction(async (tx) => {
      const w = await load(tx, req.params.id);
      if (w.status !== 'requested') throw conflict('bad_status', `Already ${w.status}`);
      await tx.update(withdrawals).set({ status: 'held', reason: req.body.reason, updatedAt: t }).where(eq(withdrawals.id, w.id));
      await notify(tx, w.userId, { kind: 'money', title: 'Withdraw under check', body: 'GoMax is checking your request. We will update you soon.', art: 'hourglass', link: { route: 'Withdraw' } });
      await audit(tx, staffActor(req), 'withdrawal_hold', 'withdrawal', w.id, null, { reason: req.body.reason });
      return { ok: true };
    });
  });

  app.post('/withdrawals/:id/reject', { preHandler: money, schema: { params: Id, body: z.object({ reason: z.string().min(3).max(200) }) } }, async (req) => {
    const t = now();
    return db.transaction(async (tx) => {
      const w = await load(tx, req.params.id);
      if (!['requested', 'held', 'approved'].includes(w.status)) throw conflict('bad_status', `Already ${w.status}`);
      if (w.payoutRef) throw conflict('sent_to_razorpay', 'Already sent to RazorpayX — wait for its result');
      await tx.update(withdrawals).set({ status: 'rejected', reason: req.body.reason, updatedAt: t, lockedBy: null, lockedUntil: null }).where(eq(withdrawals.id, w.id));
      await refund(tx, w, 'Withdraw not approved · points back', t);
      await notify(tx, w.userId, { kind: 'money', title: 'Withdraw not approved', body: req.body.reason, art: 'cross-mark', link: { route: 'WithdrawRejected', params: { id: `W-${w.id}` } } });
      await queueWhatsApp(tx, w.userId, 'withdrawal_rejected', { amount: rupees(w.amount), reason: req.body.reason });
      await audit(tx, staffActor(req), 'withdrawal_reject', 'withdrawal', w.id, { status: w.status }, { status: 'rejected', reason: req.body.reason });
      return { ok: true };
    });
  });

  // D11: "Pay manually" locks the row to one staff member for 15 min.
  app.post('/withdrawals/:id/lock', { preHandler: money, schema: { params: Id } }, async (req) => {
    const t = now();
    const s = await getSettings(db);
    const until = new Date(t.getTime() + s.payout.lockMinutes * 60_000);
    const [cur] = await db.select({ mode: withdrawals.payoutMode }).from(withdrawals).where(eq(withdrawals.id, parseWithdrawalId(req.params.id)));
    if (cur?.mode === 'razorpayx') throw conflict('auto_payout', 'This one is paid by RazorpayX — it updates by itself');
    const [w] = await db
      .update(withdrawals)
      .set({ lockedBy: req.staff.id, lockedUntil: until })
      .where(
        and(
          eq(withdrawals.id, parseWithdrawalId(req.params.id)),
          eq(withdrawals.status, 'approved'),
          or(isNull(withdrawals.lockedUntil), lte(withdrawals.lockedUntil, t), eq(withdrawals.lockedBy, req.staff.id)),
        ),
      )
      .returning();
    if (!w) throw conflict('locked', 'Someone else is paying this one, or it is not approved');
    return { lockedUntil: until.toISOString() };
  });

  app.post(
    '/withdrawals/:id/mark-paid',
    {
      preHandler: money,
      schema: { params: Id, body: z.object({ utr: z.string().regex(/^\d{12}$/, '12-digit UTR'), proofObject: z.string().startsWith('payment_proof/').max(200) }) },
    },
    async (req) => {
      const t = now();
      if (!(await app.deps.store.exists(req.body.proofObject))) throw badRequest('proof_missing', 'Upload the payment screenshot first');
      return db
        .transaction(async (tx) => {
        const w = await load(tx, req.params.id);
        if (w.status !== 'approved') throw conflict('bad_status', `Withdrawal is ${w.status}`);
        if (w.payoutMode === 'razorpayx') throw conflict('auto_payout', 'This one is paid by RazorpayX — it updates by itself');
        if (w.lockedUntil && w.lockedUntil > t && w.lockedBy !== req.staff.id) throw conflict('locked', 'Someone else is paying this one');
        const [dup] = await tx.select({ id: withdrawals.id }).from(withdrawals).where(eq(withdrawals.utr, req.body.utr));
        if (dup) throw conflict('utr_used', `This UTR is already used on W-${dup.id}`);
        await tx
          .update(withdrawals)
          .set({ status: 'paid', utr: req.body.utr, proofObject: req.body.proofObject, paidBy: req.staff.id, paidAt: t, lockedBy: null, lockedUntil: null, updatedAt: t })
          .where(eq(withdrawals.id, w.id));
        const utr = req.body.utr.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3');
        await notify(tx, w.userId, { kind: 'money', title: `${rupees(w.amount)} sent to your UPI`, body: `UTR ${utr} · ${w.upiId}`, art: 'credit-card', link: { route: 'WithdrawPaid', params: { id: `W-${w.id}` } } });
        await queueWhatsApp(tx, w.userId, 'withdrawal_paid', {
          amount: rupees(w.amount),
          upi: w.upiId,
          utr,
          date: t.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
        });
        await audit(tx, staffActor(req), 'withdrawal_paid', 'withdrawal', w.id, { status: 'approved' }, { status: 'paid', utr: req.body.utr });
        return { ok: true };
        })
        .catch((e) => {
          // The same UTR saved on another payout at the same moment.
          if (uniqueViolation(e) === 'withdrawals_utr_unique') throw conflict('utr_used', 'This UTR is already used on another payout');
          throw e;
        });
    },
  );

  // D11 "Problem — send back": back to the approval queue with a reason.
  app.post('/withdrawals/:id/send-back', { preHandler: money, schema: { params: Id, body: z.object({ reason: z.string().min(3).max(200) }) } }, async (req) => {
    const t = now();
    return db.transaction(async (tx) => {
      const w = await load(tx, req.params.id);
      if (w.status !== 'approved') throw conflict('bad_status', `Withdrawal is ${w.status}`);
      if (w.payoutRef) throw conflict('sent_to_razorpay', 'Already sent to RazorpayX — wait for its result');
      await tx.update(withdrawals).set({ status: 'requested', reason: req.body.reason, approvedBy: null, approvedAt: null, lockedBy: null, lockedUntil: null, updatedAt: t }).where(eq(withdrawals.id, w.id));
      await audit(tx, staffActor(req), 'withdrawal_send_back', 'withdrawal', w.id, null, { reason: req.body.reason });
      return { ok: true };
    });
  });

  // C4-13: payment failed (wrong UPI) → points back, user fixes UPI.
  app.post('/withdrawals/:id/fail', { preHandler: money, schema: { params: Id, body: z.object({ reason: z.string().min(3).max(200) }) } }, async (req) => {
    const t = now();
    return db.transaction(async (tx) => {
      const w = await load(tx, req.params.id);
      if (w.status !== 'approved') throw conflict('bad_status', `Withdrawal is ${w.status}`);
      if (w.payoutRef) throw conflict('sent_to_razorpay', 'Already sent to RazorpayX — wait for its result');
      await tx.update(withdrawals).set({ status: 'failed', reason: req.body.reason, lockedBy: null, lockedUntil: null, updatedAt: t }).where(eq(withdrawals.id, w.id));
      await refund(tx, w, 'Money not sent · points back', t);
      await notify(tx, w.userId, { kind: 'money', title: 'Money not sent', body: `${rupees(w.amount)} could not be sent to ${w.upiId}. Your points are back.`, art: 'warning', link: { route: 'WithdrawRejected', params: { id: `W-${w.id}` } } });
      await queueWhatsApp(tx, w.userId, 'withdrawal_failed', { amount: rupees(w.amount), upi: w.upiId });
      await audit(tx, staffActor(req), 'withdrawal_fail', 'withdrawal', w.id, null, { reason: req.body.reason });
      return { ok: true };
    });
  });

};

export default routes;
