import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { ledger, users } from '../db/schema.js';
import { conflict } from './errors.js';

type Kind = (typeof ledger.$inferInsert)['kind'];

export type Movement = {
  userId: string;
  wallet: 'points' | 'runs';
  kind: Kind;
  amount: number; // + credit, − debit
  title: string;
  sub?: string;
  ref?: string;
  /** Time of the movement (the request's clock); defaults to now. */
  at?: Date;
};

/** Points that count toward rank (earned, not refunds or adjustments). */
const EARNS_RANK: Kind[] = ['scan', 'bonus'];

/**
 * The only way balances change. Updates the user's balance and appends the
 * ledger row in the caller's transaction. A debit that would go below zero
 * fails the DB check constraint and surfaces as 409 insufficient_balance.
 */
export async function post(db: Db, m: Movement) {
  if (!Number.isInteger(m.amount) || m.amount === 0) throw new Error(`bad ledger amount ${m.amount}`);
  const col = m.wallet === 'points' ? users.points : users.runs;
  const set: Record<string, unknown> = { [m.wallet]: sql`${col} + ${m.amount}`, updatedAt: new Date() };
  if (m.wallet === 'points' && m.amount > 0 && EARNS_RANK.includes(m.kind)) {
    set.lifetimePoints = sql`${users.lifetimePoints} + ${m.amount}`;
  }
  let balance: number;
  try {
    const [row] = await db.update(users).set(set).where(eq(users.id, m.userId)).returning({ points: users.points, runs: users.runs });
    if (!row) throw new Error(`user ${m.userId} not found`);
    balance = m.wallet === 'points' ? row.points : row.runs;
  } catch (e) {
    if (String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message).includes('nonneg')) {
      throw conflict('insufficient_balance', m.wallet === 'points' ? 'Not enough points' : 'Not enough runs');
    }
    throw e;
  }
  const { at, ...row } = m;
  await db.insert(ledger).values({ ...row, balanceAfter: balance, createdAt: at ?? new Date() });
  return balance;
}
