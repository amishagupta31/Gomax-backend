import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { fraudFlags, helplineRequests, ledger, referralCredits, scans, userKyc, users } from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { decrypt } from '../../lib/crypto.js';
import { post } from '../../lib/ledger.js';
import { getSettings } from '../../lib/settings.js';
import { requireStaff, revokeAllFor, staffActor } from '../../plugins/auth.js';
import { kycState, rankView } from '../../services/account.js';
import { startWhatsAppReset } from '../auth.js';
import { page, PageQuery, timeCursor, timeKey } from '../../lib/page.js';

// D6 / D9b / M5: applicators, KYC, referral tree (levels L1–L4 are admin-only).
const Id = z.object({ id: z.uuid() });

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, config, now } = app.deps;
  const view = requireStaff('helpline', 'accounts');

  // D9b tabs: all · active · KYC to check (PAN added, no UPI yet — e.g. UPI name ≠ PAN
  // name, which the app refuses) · no PAN · blocked · cash on hold.
  const View = z.enum(['all', 'active', 'kyc', 'no_pan', 'blocked', 'hold']).default('all');
  app.get('/applicators', { preHandler: view, schema: { querystring: z.object({ q: z.string().trim().max(60).optional(), view: View, ...PageQuery }) } }, async (req) => {
    const q = req.query.q;
    const v = req.query.view;
    const digits = q?.replace(/\D/g, '') ?? '';
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        mobile: users.mobile,
        city: users.city,
        inviteCode: users.inviteCode,
        points: users.points,
        runs: users.runs,
        lifetimePoints: users.lifetimePoints,
        status: users.status,
        cashHold: users.cashHold,
        createdAt: users.createdAt,
        panAdded: sql<boolean>`${userKyc.panVerifiedAt} is not null`,
        upiAdded: sql<boolean>`${userKyc.upiVerifiedAt} is not null`,
        upiMatchesPan: userKyc.upiMatchesPan,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .leftJoin(userKyc, eq(userKyc.userId, users.id))
      .where(
        and(
          v === 'active' ? eq(users.status, 'active') : undefined,
          v === 'blocked' ? eq(users.status, 'blocked') : undefined,
          v === 'hold' ? eq(users.cashHold, true) : undefined,
          v === 'no_pan' ? isNull(userKyc.panVerifiedAt) : undefined,
          v === 'kyc' ? and(sql`${userKyc.panVerifiedAt} is not null`, isNull(userKyc.upiVerifiedAt)) : undefined,
          q ? or(ilike(users.name, `%${q}%`), digits.length >= 4 ? ilike(users.mobile, `%${digits}%`) : undefined, eq(users.inviteCode, q.toUpperCase())) : undefined,
          timeCursor(users.createdAt, users.id, req.query.cursor),
        ),
      )
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(req.query.limit + 1);
    return page(rows, req.query.limit, (r) => timeKey(r.createdAt, r.id));
  });

  app.get('/applicators/:id', { preHandler: view, schema: { params: Id } }, async (req) => {
    const [u] = await db.select().from(users).where(eq(users.id, req.params.id));
    if (!u) throw notFound('Applicator');
    const s = await getSettings(db);
    const [inviter] = u.referredBy ? await db.select({ id: users.id, name: users.name, mobile: users.mobile }).from(users).where(eq(users.id, u.referredBy)) : [];
    const [st] = await db
      .select({ added: sql<number>`count(*) filter (where ${scans.result} = 'added')::int`, failed: sql<number>`count(*) filter (where ${scans.result} <> 'added')::int` })
      .from(scans)
      .where(eq(scans.userId, u.id));
    const flags = await db.select().from(fraudFlags).where(eq(fraudFlags.userId, u.id)).orderBy(desc(fraudFlags.createdAt)).limit(20);
    const recent = await db.select().from(ledger).where(eq(ledger.userId, u.id)).orderBy(desc(ledger.id)).limit(30);
    return {
      id: u.id,
      name: u.name,
      mobile: u.mobile,
      city: u.city,
      language: u.language,
      inviteCode: u.inviteCode,
      status: u.status,
      cashHold: u.cashHold,
      lockedUntil: u.lockedUntil && u.lockedUntil > now() ? u.lockedUntil.toISOString() : null,
      points: u.points,
      runs: u.runs,
      lifetimePoints: u.lifetimePoints,
      withdrawReady: u.points >= s.withdraw.minPoints,
      rank: rankView(u.lifetimePoints, s),
      kyc: await kycState(db, u.id),
      scans: st,
      referredBy: inviter ?? null,
      flags,
      recentLedger: recent,
      createdAt: u.createdAt.toISOString(),
    };
  });

  // Full PAN for accounts/owners only, and every view is audited.
  app.get('/applicators/:id/pan', { preHandler: requireStaff('accounts'), schema: { params: Id } }, async (req) => {
    const [k] = await db.select().from(userKyc).where(eq(userKyc.userId, req.params.id));
    if (!k?.panEnc) throw notFound('PAN');
    await audit(db, staffActor(req), 'pan_view', 'user', req.params.id);
    return { pan: decrypt(k.panEnc, config.PAN_KEY), name: k.panName };
  });

  // D6a / M5: L1–L4 tree with runs the root earned from each person.
  app.get('/applicators/:id/tree', { preHandler: view, schema: { params: Id } }, async (req) => {
    const root = req.params.id;
    const levels: { level: number; people: { id: string; name: string; mobile: string; parentId: string; runsToRoot: number; scanning: boolean }[] }[] = [];
    let parents = [root];
    for (let level = 1; level <= 4 && parents.length; level++) {
      const kids = await db
        .select({ id: users.id, name: users.name, mobile: users.mobile, parentId: users.referredBy, firstCouponAt: users.firstCouponAt })
        .from(users)
        .where(inArray(users.referredBy, parents));
      const earned = kids.length
        ? await db
            .select({ from: referralCredits.fromUserId, runs: sql<number>`sum(${referralCredits.runs})::int` })
            .from(referralCredits)
            .where(and(eq(referralCredits.earnerId, root), inArray(referralCredits.fromUserId, kids.map((k) => k.id))))
            .groupBy(referralCredits.fromUserId)
        : [];
      levels.push({
        level,
        people: kids.map((k) => ({ id: k.id, name: k.name, mobile: k.mobile, parentId: k.parentId!, runsToRoot: earned.find((e) => e.from === k.id)?.runs ?? 0, scanning: Boolean(k.firstCouponAt) })),
      });
      parents = kids.map((k) => k.id);
    }
    return { levels };
  });

  // M5 "Hold cash" (same hold as fraud alerts). Owners only until the client decides on helpline.
  app.post('/applicators/:id/hold', { preHandler: requireStaff('owner'), schema: { params: Id, body: z.object({ hold: z.boolean(), reason: z.string().min(3).max(200) }) } }, async (req) => {
    const [u] = await db.update(users).set({ cashHold: req.body.hold }).where(eq(users.id, req.params.id)).returning({ id: users.id });
    if (!u) throw notFound('Applicator');
    await audit(db, staffActor(req), req.body.hold ? 'hold_cash' : 'release_cash', 'user', u.id, null, { reason: req.body.reason });
    return { ok: true };
  });

  app.post('/applicators/:id/block', { preHandler: requireStaff('owner'), schema: { params: Id, body: z.object({ blocked: z.boolean(), reason: z.string().min(3).max(200) }) } }, async (req) => {
    const [u] = await db.update(users).set({ status: req.body.blocked ? 'blocked' : 'active' }).where(eq(users.id, req.params.id)).returning({ id: users.id });
    if (!u) throw notFound('Applicator');
    if (req.body.blocked) await revokeAllFor(db, 'user', u.id, now());
    await audit(db, staffActor(req), req.body.blocked ? 'block_user' : 'unblock_user', 'user', u.id, null, { reason: req.body.reason });
    return { ok: true };
  });

  // D3: goodwill points / runs (owners only — CLIENT to confirm who else).
  app.post(
    '/applicators/:id/adjust',
    { preHandler: requireStaff('owner'), schema: { params: Id, body: z.object({ wallet: z.enum(['points', 'runs']), amount: z.number().int().refine((n) => n !== 0), reason: z.string().min(3).max(200) }) } },
    async (req) => {
      const { wallet, amount, reason } = req.body;
      if (Math.abs(amount) > 10_000) throw badRequest('too_large', 'Adjust at most 10,000 at a time');
      return db.transaction(async (tx) => {
        const balance = await post(tx, { at: now(), userId: req.params.id, wallet, kind: 'adjustment', amount, title: amount > 0 ? 'GoMax goodwill' : 'GoMax correction', sub: reason });
        await audit(tx, staffActor(req), 'adjust_balance', 'user', req.params.id, null, { wallet, amount, reason });
        return { balance };
      });
    },
  );

  // D9b / M5 helpline tools: reset password (one-time WhatsApp link, like the
  // app's own "forgot password") and unlock a login paused after wrong tries.
  const helpdesk = requireStaff('helpline');
  app.post('/applicators/:id/reset-password', { preHandler: helpdesk, schema: { params: Id } }, async (req) => {
    const [u] = await db.select({ mobile: users.mobile, status: users.status }).from(users).where(eq(users.id, req.params.id));
    if (!u) throw notFound('Applicator');
    if (u.status !== 'active') throw conflict('blocked', 'This account is blocked — unblock it first');
    await startWhatsAppReset(db, config.APP_LINK_BASE, u.mobile, now());
    await audit(db, staffActor(req), 'reset_password_link', 'user', req.params.id);
    return { ok: true, channel: 'whatsapp' };
  });

  app.post('/applicators/:id/unlock', { preHandler: helpdesk, schema: { params: Id } }, async (req) => {
    const [u] = await db.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, req.params.id)).returning({ id: users.id });
    if (!u) throw notFound('Applicator');
    await audit(db, staffActor(req), 'unlock_login', 'user', u.id);
    return { ok: true };
  });

  // D9b "Mark KYC ok": the app refuses a UPI whose name differs from the PAN and
  // sends the applicator to the helpline. Accounts check it by hand (e.g. "Raju"
  // = "Rajinder", or a shop name) and save the UPI for them. The UPI must exist.
  app.post(
    '/applicators/:id/kyc-ok',
    { preHandler: requireStaff('accounts'), schema: { params: Id, body: z.object({ upiId: z.string().trim().min(4).max(60), note: z.string().trim().min(3).max(200) }) } },
    async (req) => {
      const k = await kycState(db, req.params.id);
      if (!k.pan) throw conflict('pan_first', 'The applicator must add their PAN first');
      const r = await app.deps.kyc.lookupUpi(req.body.upiId);
      if (!r.ok) throw badRequest('upi_not_found', r.error);
      const t = now();
      const row = { upiId: req.body.upiId, upiName: r.name || k.pan.name, upiMatchesPan: true, upiVerifiedAt: t, updatedAt: t };
      await db.insert(userKyc).values({ userId: req.params.id, ...row }).onConflictDoUpdate({ target: userKyc.userId, set: row });
      await audit(db, staffActor(req), 'kyc_ok', 'user', req.params.id, null, { upiId: row.upiId, upiName: row.upiName, panName: k.pan.name, note: req.body.note });
      return { ok: true, upi: { id: row.upiId, name: row.upiName } };
    },
  );

  // A1-15/16 helpline call-back requests ("call me, I forgot my password").
  app.get('/helpline-requests', { preHandler: helpdesk, schema: { querystring: z.object({ status: z.enum(['open', 'done']).default('open') }) } }, async (req) => {
    const rows = await db
      .select({ r: helplineRequests, name: users.name })
      .from(helplineRequests)
      .leftJoin(users, eq(users.id, helplineRequests.userId))
      .where(eq(helplineRequests.status, req.query.status))
      .orderBy(desc(helplineRequests.id))
      .limit(200);
    return { rows: rows.map((x) => ({ ...x.r, name: x.name, createdAt: x.r.createdAt.toISOString() })) };
  });

  app.post('/helpline-requests/:id/done', { preHandler: helpdesk, schema: { params: z.object({ id: z.coerce.number().int() }) } }, async (req) => {
    const [r] = await db
      .update(helplineRequests)
      .set({ status: 'done', handledBy: req.staff.id })
      .where(and(eq(helplineRequests.id, req.params.id), eq(helplineRequests.status, 'open')))
      .returning({ id: helplineRequests.id });
    if (!r) throw notFound('Open request');
    await audit(db, staffActor(req), 'helpline_done', 'helpline_request', r.id);
    return { ok: true };
  });
};

export default routes;

