import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { staff } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { verifySecret } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { issueTokens, requireStaff, revokeRefresh, rotateRefresh } from '../../plugins/auth.js';

// Email (or admin ID) + password, no OTP. 5 wrong tries lock for 30 min.
// The 4-digit PIN is asked only before money approvals (checkPin).
const MAX_TRIES = 5;
const LOCK_MS = 30 * 60 * 1000;

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, config, now } = app.deps;

  app.post(
    '/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { body: z.object({ loginId: z.string().trim().min(2).max(40), password: z.string().min(1).max(72) }) },
    },
    async (req) => {
      const t = now();
      const [s] = await db.select().from(staff).where(eq(staff.loginId, req.body.loginId.toLowerCase()));
      const fail = () => new AppError(401, 'wrong_login', 'Wrong email or password');
      if (!s || !s.active) throw fail();
      if (s.lockedUntil && s.lockedUntil > t) throw new AppError(423, 'locked', 'Login locked. Ask an owner to reset it.', { until: s.lockedUntil.toISOString() });
      const ok = await verifySecret(s.passwordHash, req.body.password);
      if (!ok) {
        const n = s.failedLogins + 1;
        await db
          .update(staff)
          .set(n >= MAX_TRIES ? { failedLogins: 0, lockedUntil: new Date(t.getTime() + LOCK_MS) } : { failedLogins: n })
          .where(eq(staff.id, s.id));
        await audit(db, { type: 'staff', id: s.id, ip: req.ip }, 'login_failed', 'staff', s.id);
        throw fail();
      }
      await db.update(staff).set({ failedLogins: 0, lockedUntil: null }).where(eq(staff.id, s.id));
      await audit(db, { type: 'staff', id: s.id, ip: req.ip }, 'login', 'staff', s.id);
      const tokens = await issueTokens(db, config.JWT_SECRET, { type: 'staff', id: s.id, role: s.role }, undefined, t);
      return { staff: { id: s.id, name: s.name, role: s.role, loginId: s.loginId }, ...tokens };
    },
  );

  app.post('/refresh', { schema: { body: z.object({ refreshToken: z.string().min(10) }) } }, async (req) =>
    rotateRefresh(db, config.JWT_SECRET, req.body.refreshToken, 'staff', now()),
  );

  app.post('/logout', { schema: { body: z.object({ refreshToken: z.string().min(10) }) } }, async (req) => {
    await revokeRefresh(db, req.body.refreshToken, now());
    return { ok: true };
  });

  app.get('/me', { preHandler: requireStaff() }, async (req) => req.staff);
};

export default routes;
