import { sql } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';

type Row = Record<string, unknown>;
const rows = async (db: Db, q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: Row[] }).rows;

/**
 * Money rules that must hold after ANY sequence of requests, however many run
 * at once. Returns a list of violations (empty = all good).
 */
export async function moneyInvariants(db: Db): Promise<string[]> {
  const bad: string[] = [];

  // 1. Balance = sum of the ledger, per wallet.
  for (const r of await rows(
    db,
    sql`select u.mobile, u.points, u.runs,
          coalesce(sum(l.amount) filter (where l.wallet = 'points'), 0)::int as lp,
          coalesce(sum(l.amount) filter (where l.wallet = 'runs'), 0)::int as lr
        from gomax.users u left join gomax.ledger l on l.user_id = u.id
        group by u.id
        having u.points <> coalesce(sum(l.amount) filter (where l.wallet = 'points'), 0)
            or u.runs <> coalesce(sum(l.amount) filter (where l.wallet = 'runs'), 0)`,
  )) {
    bad.push(`balance≠ledger for ${r.mobile}: points ${r.points} vs ${r.lp}, runs ${r.runs} vs ${r.lr}`);
  }

  // 2. No negative balances (the DB check should make this impossible).
  for (const r of await rows(db, sql`select mobile, points, runs from gomax.users where points < 0 or runs < 0`)) {
    bad.push(`negative balance for ${r.mobile}`);
  }

  // 3. Each ledger row's balance_after continues the previous one (per user + wallet, in id order).
  for (const r of await rows(
    db,
    sql`select user_id, wallet, id from (
          select user_id, wallet, id, amount, balance_after,
                 lag(balance_after, 1, 0) over (partition by user_id, wallet order by id) as prev
          from gomax.ledger) x
        where balance_after <> prev + amount`,
  )) {
    bad.push(`ledger chain broken at ${r.wallet} row ${r.id}`);
  }

  // 4. A coupon is added at most once, and only to the person it is marked scanned by.
  for (const r of await rows(db, sql`select coupon_id, count(*)::int n from gomax.scans where result = 'added' group by coupon_id having count(*) > 1`)) {
    bad.push(`coupon ${r.coupon_id} added ${r.n} times`);
  }
  for (const r of await rows(
    db,
    sql`select c.code from gomax.coupons c join gomax.scans s on s.coupon_id = c.id and s.result = 'added' where c.scanned_by is distinct from s.user_id`,
  )) {
    bad.push(`coupon ${r.code} scanned_by does not match its added scan`);
  }

  // 5. Every withdrawal has exactly one debit; rejected/failed ones exactly one refund.
  for (const r of await rows(
    db,
    sql`select w.id, w.status,
          count(*) filter (where l.kind = 'withdraw')::int as debits,
          count(*) filter (where l.kind = 'withdraw_refund')::int as refunds
        from gomax.withdrawals w left join gomax.ledger l on l.ref = 'withdrawal:' || w.id
        group by w.id`,
  )) {
    const wantRefund = r.status === 'rejected' || r.status === 'failed' ? 1 : 0;
    if (r.debits !== 1 || r.refunds !== wantRefund) bad.push(`withdrawal W-${r.id} (${r.status}): ${r.debits} debits, ${r.refunds} refunds`);
  }

  // 6. Every gift order has exactly one runs debit.
  for (const r of await rows(
    db,
    sql`select o.id, count(l.id)::int n from gomax.gift_orders o left join gomax.ledger l on l.ref = 'gift_order:' || o.id group by o.id having count(l.id) <> 1`,
  )) {
    bad.push(`gift order G-${r.id} has ${r.n} debits`);
  }

  // 7. Stock never below zero.
  for (const r of await rows(db, sql`select id from gomax.gifts where stock < 0`)) bad.push(`gift ${r.id} stock < 0`);

  // 8. UTRs unique among paid withdrawals (also a DB constraint).
  for (const r of await rows(db, sql`select utr from gomax.withdrawals where utr is not null group by utr having count(*) > 1`)) bad.push(`UTR ${r.utr} used twice`);

  return bad;
}
