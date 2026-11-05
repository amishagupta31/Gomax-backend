import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { userKyc, users, withdrawals } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { post } from '../lib/ledger.js';
import { notify, queueWhatsApp } from '../lib/notify.js';
import { FINAL_FAIL, RazorpayError, type Payout, type RazorpayClient } from '../lib/razorpay.js';

// PAYOUT_MODE=razorpayx: approved withdrawals are paid by RazorpayX.
//   approve (staff + PIN) → payouts job sends it → Razorpay webhook (or the
//   sync below) reports processed → Paid with the bank UTR, or failed /
//   rejected / reversed → points returned.
// Every send uses the idempotency key "gomax-W-<id>", so a retry after a
// crash or timeout can never pay twice.

const SYSTEM = { type: 'system' as const };
const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;
export const idempotencyKey = (withdrawalId: number) => `gomax-W-${withdrawalId}`;

type Row = typeof withdrawals.$inferSelect;

/** Contact + UPI fund account for this user's payout UPI, created once and reused. */
async function fundAccountFor(db: Db, rzp: RazorpayClient, w: Row) {
  const [k] = await db.select().from(userKyc).where(eq(userKyc.userId, w.userId));
  if (k?.rzpFundAccountId && k.rzpFundAccountVpa === w.upiId) return k.rzpFundAccountId;
  const [u] = await db.select({ name: users.name, mobile: users.mobile }).from(users).where(eq(users.id, w.userId));
  const contactId = k?.rzpContactId ?? (await rzp.createContact({ name: w.upiName ?? u.name, mobile: u.mobile, referenceId: w.userId })).id;
  const fa = await rzp.createVpaFundAccount(contactId, w.upiId);
  await db
    .insert(userKyc)
    .values({ userId: w.userId, rzpContactId: contactId, rzpFundAccountId: fa.id, rzpFundAccountVpa: w.upiId })
    .onConflictDoUpdate({ target: userKyc.userId, set: { rzpContactId: contactId, rzpFundAccountId: fa.id, rzpFundAccountVpa: w.upiId } });
  return fa.id;
}

/** Job: send every approved RazorpayX withdrawal that hasn't been sent yet. */
export async function sendPayouts(db: Db, rzp: RazorpayClient, now: Date) {
  const stale = new Date(now.getTime() - 5 * 60_000);
  // Claim rows (SKIP LOCKED: two job runs never take the same row).
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(withdrawals)
      .where(
        and(
          eq(withdrawals.status, 'approved'),
          eq(withdrawals.payoutMode, 'razorpayx'),
          isNull(withdrawals.payoutRef),
          or(isNull(withdrawals.payoutStatus), eq(withdrawals.payoutStatus, 'error'), and(eq(withdrawals.payoutStatus, 'sending'), lt(withdrawals.payoutSentAt, stale))),
        ),
      )
      .orderBy(withdrawals.id)
      .limit(50)
      .for('update', { skipLocked: true });
    if (rows.length) {
      await tx.update(withdrawals).set({ payoutStatus: 'sending', payoutSentAt: now, payoutError: null }).where(inArray(withdrawals.id, rows.map((r) => r.id)));
    }
    return rows;
  });

  let sent = 0;
  let failed = 0;
  for (const w of claimed) {
    try {
      const fundAccountId = await fundAccountFor(db, rzp, w);
      const payout = await rzp.createPayout({
        fundAccountId,
        amountPaise: w.amount * 100,
        referenceId: `W-${w.id}`,
        narration: `GoMax W${w.id}`,
        idempotencyKey: idempotencyKey(w.id),
        notes: { withdrawal: `W-${w.id}`, user_id: w.userId },
      });
      await db.update(withdrawals).set({ payoutRef: payout.id, payoutStatus: payout.status, updatedAt: now }).where(eq(withdrawals.id, w.id));
      await audit(db, SYSTEM, 'payout_sent', 'withdrawal', w.id, null, { payoutId: payout.id, status: payout.status });
      sent++;
      if (payout.status === 'processed' || FINAL_FAIL.includes(payout.status)) await applyPayoutUpdate(db, payout, now);
    } catch (e) {
      // Left as "approved" with the error shown to staff; the next run retries with the same idempotency key.
      const msg = e instanceof RazorpayError ? `${e.code}: ${e.message}` : String((e as Error).message);
      await db.update(withdrawals).set({ payoutStatus: 'error', payoutError: msg.slice(0, 500), updatedAt: now }).where(eq(withdrawals.id, w.id));
      failed++;
    }
  }
  return { sent, failed };
}

/** Applies a RazorpayX payout status (from a webhook or a status check). Safe to call many times. */
export async function applyPayoutUpdate(db: Db, p: Payout, now: Date) {
  const idFromRef = p.reference_id?.match(/^W-(\d+)$/)?.[1];
  return db.transaction(async (tx) => {
    const [w] = await tx
      .select()
      .from(withdrawals)
      .where(or(eq(withdrawals.payoutRef, p.id), idFromRef ? eq(withdrawals.id, Number(idFromRef)) : undefined))
      .for('update');
    if (!w || w.payoutMode !== 'razorpayx') return { applied: false };
    if (w.payoutRef && w.payoutRef !== p.id) return { applied: false }; // a different payout for this withdrawal

    if (p.status === 'processed') {
      if (w.status === 'paid') return { applied: false };
      if (w.status !== 'approved') return { applied: false };
      const utr = (p.utr ?? '').replace(/\s/g, '').slice(0, 12) || null;
      await tx.update(withdrawals).set({ status: 'paid', utr, paidAt: now, payoutRef: p.id, payoutStatus: 'processed', updatedAt: now }).where(eq(withdrawals.id, w.id));
      const spaced = utr ? utr.replace(/(\d{4})(?=\d)/g, '$1 ') : '';
      await notify(tx, w.userId, { kind: 'money', title: `${rupees(w.amount)} sent to your UPI`, body: utr ? `UTR ${spaced} · ${w.upiId}` : w.upiId, art: 'credit-card', link: { route: 'WithdrawPaid', params: { id: `W-${w.id}` } } });
      await queueWhatsApp(tx, w.userId, 'withdrawal_paid', {
        amount: rupees(w.amount),
        upi: w.upiId,
        utr: spaced,
        date: now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
      });
      await audit(tx, SYSTEM, 'withdrawal_paid', 'withdrawal', w.id, { status: w.status }, { status: 'paid', utr, via: 'razorpayx', payoutId: p.id });
      return { applied: true };
    }

    if (FINAL_FAIL.includes(p.status)) {
      // Reversed after "processed" means the money came back to us: return the points too.
      if (w.status !== 'approved' && !(w.status === 'paid' && p.status === 'reversed')) return { applied: false };
      const reason = p.status_details?.description || p.failure_reason || `Payout ${p.status}`;
      await tx.update(withdrawals).set({ status: 'failed', reason, payoutRef: p.id, payoutStatus: p.status, updatedAt: now }).where(eq(withdrawals.id, w.id));
      await post(tx, { at: now, userId: w.userId, wallet: 'points', kind: 'withdraw_refund', amount: w.amount, title: 'Money not sent · points back', sub: `W-${w.id}`, ref: `withdrawal:${w.id}` });
      await notify(tx, w.userId, { kind: 'money', title: 'Money not sent', body: `${rupees(w.amount)} could not be sent to ${w.upiId}. Your points are back.`, art: 'warning', link: { route: 'WithdrawRejected', params: { id: `W-${w.id}` } } });
      await queueWhatsApp(tx, w.userId, 'withdrawal_failed', { amount: rupees(w.amount), upi: w.upiId });
      await audit(tx, SYSTEM, 'withdrawal_fail', 'withdrawal', w.id, { status: w.status }, { status: 'failed', via: 'razorpayx', payoutStatus: p.status, reason });
      return { applied: true };
    }

    // queued / pending / processing: just remember where it is.
    if (w.payoutStatus !== p.status) await tx.update(withdrawals).set({ payoutStatus: p.status, payoutRef: p.id, updatedAt: now }).where(eq(withdrawals.id, w.id));
    return { applied: false };
  });
}

/** Job: ask Razorpay about payouts still in flight after 30 min (in case a webhook was missed). */
export async function syncPayouts(db: Db, rzp: RazorpayClient, now: Date) {
  const rows = await db
    .select({ ref: withdrawals.payoutRef })
    .from(withdrawals)
    .where(and(eq(withdrawals.status, 'approved'), eq(withdrawals.payoutMode, 'razorpayx'), isNotNull(withdrawals.payoutRef), lt(withdrawals.payoutSentAt, new Date(now.getTime() - 30 * 60_000))))
    .limit(100);
  let updated = 0;
  for (const r of rows) {
    try {
      if ((await applyPayoutUpdate(db, await rzp.getPayout(r.ref!), now)).applied) updated++;
    } catch {
      /* try again next run */
    }
  }
  return { checked: rows.length, updated };
}
