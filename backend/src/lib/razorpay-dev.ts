// Local stand-in for RazorpayX (npm run dev:local with PAYOUT_MODE=razorpayx and
// no keys). Payouts stay "processing" until you play Razorpay's webhook:
//   npm run rzp:webhook -- <pout_id> processed
// Never used in production: main.ts only builds the real client.
import type { Payout, RazorpayClient } from './razorpay.js';

export function devRazorpay(log: (msg: string) => void = console.log): RazorpayClient {
  let seq = 0;
  const id = (p: string) => `${p}_dev${String(++seq).padStart(6, '0')}`;
  const payouts = new Map<string, Payout>();
  const byKey = new Map<string, string>();
  return {
    accountNumber: 'DEV-ACCOUNT',
    async createContact(c) {
      const r = { id: id('cont') };
      log(`[razorpay-dev] contact ${r.id} for ${c.name} (${c.mobile})`);
      return r;
    },
    async createVpaFundAccount(contactId, vpa) {
      const r = { id: id('fa') };
      log(`[razorpay-dev] fund account ${r.id} → ${vpa}`);
      return r;
    },
    async validateVpa() {
      return { active: true, name: null };
    },
    async createPayout(p) {
      const existing = byKey.get(p.idempotencyKey);
      if (existing) return payouts.get(existing)!;
      const payout: Payout = { id: id('pout'), status: 'processing', amount: p.amountPaise, utr: null, reference_id: p.referenceId };
      payouts.set(payout.id, payout);
      byKey.set(p.idempotencyKey, payout.id);
      log(`[razorpay-dev] payout ${payout.id} ₹${p.amountPaise / 100} (${p.referenceId}) is processing.\n  Finish it: npm run rzp:webhook -- ${payout.id} processed   (or failed / rejected / reversed)`);
      return payout;
    },
    async getPayout(payoutId) {
      const p = payouts.get(payoutId);
      if (!p) throw new Error(`no payout ${payoutId}`);
      return p;
    },
  };
}
