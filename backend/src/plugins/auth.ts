import fp from 'fastify-plugin';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import { refreshTokens, staff, users } from '../db/schema.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { randomToken, sha256, verifySecret } from '../lib/crypto.js';
import { ACCESS_TTL_SEC, REFRESH_TTL_DAYS, signAccess, verifyAccess } from '../lib/jwt.js';
import type { Actor } from '../lib/audit.js';

export type StaffRole = 'owner' | 'accounts' | 'factory' | 'helpline' | 'ops';
export type StaffPrincipal = { id: string; role: StaffRole; name: string };

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    /** The signed-in applicator's row, loaded once by requireUser. */
    currentUser: typeof users.$inferSelect;
    staff: StaffPrincipal;
  }
}

const bearer = (req: FastifyRequest) => {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
};

export const authPlugin = fp(async (app) => {
  app.decorateRequest('userId', '');
  app.decorateRequest('currentUser', null as unknown as typeof users.$inferSelect);
  app.decorateRequest('staff', null as unknown as StaffPrincipal);
});

/** preHandler: signed-in, active applicator. */
export async function requireUser(req: FastifyRequest, _reply: FastifyReply) {
  const token = bearer(req);
  if (!token) throw unauthorized();
  const claims = await verifyAccess(token, req.server.deps.config.JWT_SECRET).catch(() => null);
  if (!claims || claims.typ !== 'user') throw unauthorized();
  const [u] = await req.server.deps.db.select().from(users).where(eq(users.id, claims.sub));
  if (!u) throw unauthorized();
  if (u.status !== 'active') throw forbidden('This account is blocked. Call GoMax helpline 92158 44410.');
  req.userId = claims.sub;
  req.currentUser = u;
}

/** preHandler factory: signed-in staff with one of `roles` (owners can do everything). */
export function requireStaff(...roles: StaffRole[]) {
  return async (req: FastifyRequest) => {
    const token = bearer(req);
    if (!token) throw unauthorized();
    const claims = await verifyAccess(token, req.server.deps.config.JWT_SECRET).catch(() => null);
    if (!claims || claims.typ !== 'staff') throw unauthorized();
    const [s] = await req.server.deps.db
      .select({ id: staff.id, role: staff.role, name: staff.name, active: staff.active, lockedUntil: staff.lockedUntil })
      .from(staff)
      .where(eq(staff.id, claims.sub));
    if (!s || !s.active) throw unauthorized();
    // A locked login (wrong passwords or PINs) also stops sessions that are already open.
    if (s.lockedUntil && s.lockedUntil > req.server.deps.now()) throw unauthorized('Login locked. Ask an owner to unlock it.');
    if (s.role !== 'owner' && roles.length && !roles.includes(s.role)) throw forbidden();
    req.staff = { id: s.id, role: s.role, name: s.name };
  };
}

export const staffActor = (req: FastifyRequest): Actor => ({ type: 'staff', id: req.staff.id, ip: req.ip });

export const PIN_MAX_TRIES = 5;
const PIN_LOCK_MS = 30 * 60 * 1000;

/**
 * Money actions ask for the 4-digit PIN again (M1). Wrong PINs count toward
 * the same lockout as wrong passwords: after 5, the staff login is locked
 * for 30 min and every open session is signed out — so a stolen session
 * cannot try all 10,000 PINs.
 */
export async function checkPin(db: Db, staffId: string, pin: string | undefined, now: Date) {
  if (!pin) throw forbidden('Enter your PIN');
  const [s] = await db.select({ pinHash: staff.pinHash, failed: staff.failedLogins }).from(staff).where(eq(staff.id, staffId));
  if (s && (await verifySecret(s.pinHash, pin))) {
    if (s.failed) await db.update(staff).set({ failedLogins: 0 }).where(eq(staff.id, staffId));
    return;
  }
  const fails = (s?.failed ?? 0) + 1;
  if (fails >= PIN_MAX_TRIES) {
    await db.update(staff).set({ failedLogins: 0, lockedUntil: new Date(now.getTime() + PIN_LOCK_MS) }).where(eq(staff.id, staffId));
    await revokeAllFor(db, 'staff', staffId, now);
    throw unauthorized('Too many wrong PINs. Login locked for 30 minutes.');
  }
  await db.update(staff).set({ failedLogins: fails }).where(eq(staff.id, staffId));
  throw new AppError(403, 'forbidden', 'Wrong PIN', { triesLeft: PIN_MAX_TRIES - fails });
}

export async function issueTokens(db: Db, secret: string, subject: { type: 'user' | 'staff'; id: string; role?: string }, deviceId?: string, now = new Date()) {
  const claims = subject.type === 'user' ? { sub: subject.id, typ: 'user' as const } : { sub: subject.id, typ: 'staff' as const, role: subject.role ?? '' };
  const accessToken = await signAccess(claims, secret);
  const refreshToken = randomToken();
  await db.insert(refreshTokens).values({
    subjectType: subject.type,
    subjectId: subject.id,
    tokenHash: sha256(refreshToken),
    deviceId: deviceId ?? null,
    expiresAt: new Date(now.getTime() + REFRESH_TTL_DAYS[subject.type] * 86_400_000),
  });
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SEC };
}

/** Refresh-token rotation: the old token is revoked; reuse of a revoked token fails. */
export async function rotateRefresh(db: Db, secret: string, token: string, type: 'user' | 'staff', now = new Date()) {
  const [row] = await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.tokenHash, sha256(token)), eq(refreshTokens.subjectType, type), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, now)))
    .returning();
  if (!row) throw unauthorized();
  let role: string | undefined;
  if (type === 'staff') {
    const [s] = await db.select({ role: staff.role, active: staff.active }).from(staff).where(eq(staff.id, row.subjectId));
    if (!s?.active) throw unauthorized();
    role = s.role;
  } else {
    const [u] = await db.select({ status: users.status }).from(users).where(eq(users.id, row.subjectId));
    if (u?.status !== 'active') throw unauthorized();
  }
  return issueTokens(db, secret, { type, id: row.subjectId, role }, row.deviceId ?? undefined, now);
}

export async function revokeRefresh(db: Db, token: string, now = new Date()) {
  await db.update(refreshTokens).set({ revokedAt: now }).where(eq(refreshTokens.tokenHash, sha256(token)));
}

export async function revokeAllFor(db: Db, type: 'user' | 'staff', id: string, now = new Date()) {
  await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.subjectType, type), eq(refreshTokens.subjectId, id), isNull(refreshTokens.revokedAt)));
}
