// Postgres error helpers. Under parallel traffic two requests can both pass a
// "does it exist?" check and race to insert; the unique constraint stops the
// second one. These turn that into a clean 409 instead of a 500.

type PgLike = { code?: string; constraint?: string; cause?: unknown };

function pgError(e: unknown): PgLike | null {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    const x = cur as PgLike;
    if (typeof x.code === 'string' && /^[0-9A-Z]{5}$/.test(x.code)) return x;
    cur = x.cause;
  }
  return null;
}

/** The violated unique constraint's name, or null if `e` is not a unique violation. */
export function uniqueViolation(e: unknown): string | null {
  const p = pgError(e);
  return p?.code === '23505' ? (p.constraint ?? '') : null;
}
