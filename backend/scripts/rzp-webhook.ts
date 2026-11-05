// Plays a RazorpayX payout webhook against a local API, signed the way
// Razorpay signs it (HMAC-SHA256 of the body with RAZORPAY_WEBHOOK_SECRET).
//   npm run rzp:webhook -- <pout_id> processed [utr]
//   npm run rzp:webhook -- <pout_id> failed|rejected|reversed [reason]
// Optional: API_URL (default http://localhost:8080), BAD_SIGNATURE=1 to check the 403.
import { createHmac, randomInt } from 'node:crypto';

const [payoutId, status = 'processed', extra] = process.argv.slice(2);
const statuses = ['processed', 'failed', 'rejected', 'reversed', 'cancelled', 'queued', 'pending', 'processing'];
if (!payoutId?.startsWith('pout_') || !statuses.includes(status)) {
  console.error(`Usage: npm run rzp:webhook -- <pout_id> <${statuses.join('|')}> [utr or reason]`);
  process.exit(1);
}
const secret = process.env.RAZORPAY_WEBHOOK_SECRET ?? 'dev-webhook-secret';
const api = process.env.API_URL ?? 'http://localhost:8080';

const entity: Record<string, unknown> = { id: payoutId, entity: 'payout', status, utr: null };
if (status === 'processed') entity.utr = extra ?? String(randomInt(1e11, 1e12));
else if (extra) entity.status_details = { description: extra, reason: 'manual_test' };

const body = JSON.stringify({ entity: 'event', event: `payout.${status}`, contains: ['payout'], payload: { payout: { entity } }, created_at: Math.floor(Date.now() / 1000) });
const signature = createHmac('sha256', process.env.BAD_SIGNATURE ? 'wrong-secret' : secret).update(body).digest('hex');

const res = await fetch(`${api}/webhooks/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature }, body });
console.log(`payout.${status} → ${res.status} ${await res.text()}`);
if (entity.utr) console.log(`UTR sent: ${entity.utr}`);
