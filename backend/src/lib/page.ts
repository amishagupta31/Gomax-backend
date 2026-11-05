import { and, eq, lt, or, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { badRequest } from './errors.js';

// Cursor pagination (no OFFSET). Lists ask for limit + 1 rows; if the extra
// row exists there is a next page and `nextCursor` points at the last row.

export const PageQuery = {
  cursor: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
};

/** Newest-first by a numeric id: cursor = last id seen. */
export const idCursor = (col: PgColumn, cursor?: string): SQL | undefined => {
  if (!cursor) return undefined;
  const n = Number(cursor);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('bad_cursor', 'Invalid cursor');
  return lt(col, n);
};

/** Newest-first by (time, id) — for lists ordered by an event time. Cursor = "<ms>_<id>". */
export function timeCursor(timeCol: PgColumn, idCol: PgColumn, cursor?: string): SQL | undefined {
  if (!cursor) return undefined;
  const m = cursor.match(/^(\d+)_([\w-]+)$/);
  if (!m) throw badRequest('bad_cursor', 'Invalid cursor');
  const at = new Date(Number(m[1]));
  const id = /^\d+$/.test(m[2]) ? Number(m[2]) : m[2];
  return or(lt(timeCol, at), and(eq(timeCol, at), lt(idCol, id)));
}

export function page<T>(rows: T[], limit: number, cursorOf: (r: T) => string) {
  const more = rows.length > limit;
  const out = more ? rows.slice(0, limit) : rows;
  return { rows: out, nextCursor: more && out.length ? cursorOf(out[out.length - 1]) : null };
}

export const timeKey = (at: Date, id: string | number) => `${at.getTime()}_${id}`;
