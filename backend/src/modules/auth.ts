import { randomInt } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { helplineRequests, passwordResets, users } from '../db/schema.js';
import { badRequest, conflict, notFound, AppError } from '../lib/errors.js';
import { hashSecret, randomToken, sha256, verifySecret } from '../lib/crypto.js';
import { queueWhatsApp } from '../lib/notify.js';
import { issueTokens, revokeAllFor, revokeRefresh, rotateRefresh } from '../plugins/auth.js';
import { checkSharedDevice } from '../services/fraud.js';
import type { Db } from '../db/client.js';
import { uniqueViolation } from '../lib/pgerrors.js';
import { PhoneTokenError } from '../lib/firebase.js';

// A1 Onboarding. Login = mobile + password, no OTP. 3 wrong tries pause
// login for 30 min (A1-05). Reset = WhatsApp message from the registered
// number (webhooks.ts) or a helpline call-back request.
export const MAX_TRIES = 3;
export const PAUSE_MS = 30 * 60 * 1000;

export const Mobile = z
  .string()
  .transform((s) => s.replace(/\D/g, '').slice(-10))
  .refine((s) => /^[6-9]\d{9}$/.test(s), 'Enter a 10-digit mobile number');
export const Password = z
  .string()
  .min(8, 'At least 8 characters')
  .max(72)
  .refine((s) => /\d/.test(s), 'Add at least one number (0–9)');
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** RAM245-style code: 3 letters of the first name + 3 digits, unique. */
async function newInviteCode(db: Db, name: string) {
  const letters = (name.replace(/[^a-z]/gi, '').toUpperCase() + 'GMX').slice(0, 3);
  for (let i = 0; i < 20; i++) {
    const code = `${letters}${randomInt(100, 1000)}`;
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.inviteCode, code));
    if (!taken) return code;
  }
  return `${letters}${randomInt(100000, 1000000)}`;
}

const findByCode = (db: Db, code: string) =>
  db
    .select({ id: users.id, name: users.name, status: users.status })
    .from(users)
    .where(eq(users.inviteCode, code.trim().toUpperCase()))
    .then((r) => r[0]);

const publicUser = (u: typeof users.$inferSelect) => ({ id: u.id, name: u.name, mobile: u.mobile, inviteCode: u.inviteCode });

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, config, now } = app.deps;
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post(
    '/signup',
    {
      ...strict,
      schema: {
        body: z.object({
          name: z.string().trim().min(2).max(80),
          mobile: Mobile,
          password: Password,
          referralCode: z.string().trim().max(20).optional(),
          birthday: IsoDate.optional(),
          anniversary: IsoDate.optional(),
          city: z.string().trim().max(60).optional(),
          language: z.enum(['hi', 'en', 'pa']).optional(),
          deviceId: z.string().max(100).optional(),
          /** Firebase ID token from the SMS OTP step — required when OTP is switched on. */
          firebaseToken: z.string().min(20).max(4096).optional(),
        }),
      },
    },
    async (req) => {
      const b = req.body;
      // SMS OTP (Firebase Phone Auth): the number must be the one the OTP was sent to.
      let proof: { mobile: string; firebaseUid: string } | null = null;
      if (app.deps.verifyPhone) {
        if (!b.firebaseToken) throw badRequest('otp_required', 'Verify your mobile number with the OTP first');
        try {
          proof = await app.deps.verifyPhone(b.firebaseToken);
        } catch (e) {
          if (e instanceof PhoneTokenError) throw new AppError(401, 'otp_invalid', e.message);
          throw e;
        }
        if (proof.mobile !== b.mobile) throw badRequest('otp_mobile_mismatch', 'The OTP was for a different number');
      }
      const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.mobile, b.mobile));
      if (exists) throw conflict('mobile_taken', 'This number already has an account. Log in instead.');
      let referredBy: string | null = null;
      if (b.referralCode) {
        const inviter = await findByCode(db, b.referralCode);
        if (!inviter || inviter.status !== 'active') throw badRequest('bad_referral', 'This referral code is not valid');
        referredBy = inviter.id;
      }
      const create = () => db.transaction(async (tx) => {
        const [u] = await tx
          .insert(users)
          .values({
            name: b.name,
            mobile: b.mobile,
            passwordHash: await hashSecret(b.password),
            inviteCode: await newInviteCode(tx, b.name),
            referredBy,
            birthday: b.birthday ?? null,
            anniversary: b.anniversary ?? null,
            city: b.city ?? null,
            language: b.language ?? 'hi',
            lastDeviceId: b.deviceId ?? null,
            phoneVerifiedAt: proof ? now() : null,
            firebaseUid: proof?.firebaseUid ?? null,
          })
          .returning();
        await queueWhatsApp(tx, u.id, 'welcome', { mobile: `${b.mobile.slice(0, 5)} ${b.mobile.slice(5)}` });
        if (b.deviceId) await checkSharedDevice(tx, u.id, b.deviceId);
        return u;
      });
      let user: typeof users.$inferSelect | undefined;
      for (let attempt = 0; !user; attempt++) {
        try {
          user = await create();
        } catch (e) {
          const c = uniqueViolation(e);
          // Same number signing up twice at the same moment: the second one loses cleanly.
          if (c === 'users_mobile_unique') throw conflict('mobile_taken', 'This number already has an account. Log in instead.');
          // Two people got the same random invite code at once: try a new one.
          if (c === 'users_invite_code_unique' && attempt < 3) continue;
          throw e;
        }
      }
      const tokens = await issueTokens(db, config.JWT_SECRET, { type: 'user', id: user.id }, b.deviceId, now());
      return { user: publicUser(user), ...tokens };
    },
  );

  app.post(
    '/login',
    {
      ...strict,
      schema: { body: z.object({ mobile: Mobile, password: z.string().min(1).max(72), deviceId: z.string().max(100).optional() }) },
    },
    async (req) => {
      const { mobile, password, deviceId } = req.body;
      const t = now();
      const [u] = await db.select().from(users).where(eq(users.mobile, mobile));
      if (!u) throw new AppError(404, 'not_registered', 'This number is not registered. Sign up first.');
      if (u.lockedUntil && u.lockedUntil > t) {
        throw new AppError(423, 'paused', 'Too many wrong tries. Try again later.', { until: u.lockedUntil.toISOString() });
      }
      if (!(await verifySecret(u.passwordHash, password))) {
        const fails = u.failedLogins + 1;
        if (fails >= MAX_TRIES) {
          const until = new Date(t.getTime() + PAUSE_MS);
          await db.update(users).set({ failedLogins: 0, lockedUntil: until }).where(eq(users.id, u.id));
          throw new AppError(423, 'paused', 'Too many wrong tries. Try again later.', { until: until.toISOString() });
        }
        await db.update(users).set({ failedLogins: fails }).where(eq(users.id, u.id));
        throw new AppError(401, 'wrong_password', 'Wrong password', { triesLeft: MAX_TRIES - fails });
      }
      if (u.status !== 'active') throw new AppError(403, 'blocked', 'This account is blocked. Call GoMax helpline 92158 44410.');
      await db.transaction(async (tx) => {
        await tx.update(users).set({ failedLogins: 0, lockedUntil: null, lastDeviceId: deviceId ?? u.lastDeviceId }).where(eq(users.id, u.id));
        if (deviceId && deviceId !== u.lastDeviceId) await checkSharedDevice(tx, u.id, deviceId);
      });
      const tokens = await issueTokens(db, config.JWT_SECRET, { type: 'user', id: u.id }, deviceId, t);
      return { user: publicUser(u), ...tokens };
    },
  );

  app.post('/refresh', { schema: { body: z.object({ refreshToken: z.string().min(10) }) } }, async (req) =>
    rotateRefresh(db, config.JWT_SECRET, req.body.refreshToken, 'user', now()),
  );

  app.post('/logout', { schema: { body: z.object({ refreshToken: z.string().min(10) }) } }, async (req) => {
    await revokeRefresh(db, req.body.refreshToken, now());
    return { ok: true };
  });

  // A1-07: shows "Referred by <name>" while typing the code.
  app.get('/referral/:code', { ...strict, schema: { params: z.object({ code: z.string().max(20) }) } }, async (req) => {
    const inviter = await findByCode(db, req.params.code);
    if (!inviter || inviter.status !== 'active') throw notFound('Referral code');
    return { name: inviter.name };
  });

  // A1-10: "Forgot password" first checks the number exists.
  app.get('/registered', { ...strict, schema: { querystring: z.object({ mobile: Mobile }) } }, async (req) => {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.mobile, req.query.mobile));
    return { registered: Boolean(u), whatsappNumber: config.WA_BUSINESS_NUMBER };
  });

  // A1-15/16: helpline call-back. Same answer whether or not the number exists.
  app.post('/reset-request', { ...strict, schema: { body: z.object({ mobile: Mobile }) } }, async (req) => {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.mobile, req.body.mobile));
    await db.insert(helplineRequests).values({ mobile: req.body.mobile, userId: u?.id ?? null });
    return { ok: true, channel: 'helpline' };
  });

  // A1-13: new password, using the token from the WhatsApp reset link (valid 15 min, once).
  app.post('/reset-password', { ...strict, schema: { body: z.object({ token: z.string().min(20), password: Password }) } }, async (req) => {
    const t = now();
    return db.transaction(async (tx) => {
      const [r] = await tx
        .update(passwordResets)
        .set({ usedAt: t })
        .where(and(eq(passwordResets.tokenHash, sha256(req.body.token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, t)))
        .returning();
      if (!r) throw badRequest('link_expired', 'This link has expired. Send RESET on WhatsApp again.');
      await tx
        .update(users)
        .set({ passwordHash: await hashSecret(req.body.password), failedLogins: 0, lockedUntil: null, updatedAt: t })
        .where(eq(users.id, r.userId));
      await revokeAllFor(tx, 'user', r.userId, t);
      const [u] = await tx.select({ mobile: users.mobile }).from(users).where(eq(users.id, r.userId));
      return { ok: true, mobile: u.mobile };
    });
  });
};

/** Creates a one-time reset link and queues it on WhatsApp (C4-11). */
export async function startWhatsAppReset(db: Db, appLinkBase: string, mobile: string, now: Date) {
  const [u] = await db.select({ id: users.id, status: users.status }).from(users).where(eq(users.mobile, mobile));
  if (!u || u.status !== 'active') return false;
  const token = randomToken();
  await db.insert(passwordResets).values({ userId: u.id, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + 15 * 60 * 1000) });
  await queueWhatsApp(db, u.id, 'password_reset', { link: `${appLinkBase}/reset?t=${token}` }, { force: true });
  return true;
}

export default routes;
