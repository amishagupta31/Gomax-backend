import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auditLog, fraudFlags, giftOrders, products, scans, settings, staff, streakPhotos, users, withdrawals } from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { hashSecret } from '../../lib/crypto.js';
import { clearSettingsCache, DEFAULT_SETTINGS, getSettings, SettingsSchema, type SettingsKey } from '../../lib/settings.js';
import { istDay } from '../../lib/time.js';
import { requireStaff, revokeAllFor, staffActor } from '../../plugins/auth.js';
import { idCursor, page, PageQuery } from '../../lib/page.js';
import { ext, IMAGE_TYPES } from '../uploads.js';

// D1 dashboard · D9 settings, audit log, staff logins · admin uploads.
const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, store, now } = app.deps;

  // D1 / M1 home tiles — live counts for today (IST).
  app.get('/dashboard', { preHandler: requireStaff('accounts', 'factory', 'helpline', 'ops') }, async (req) => {
    const day = istDay(now());
    const [sc] = await db
      .select({ added: sql<number>`count(*) filter (where ${scans.result} = 'added')::int`, points: sql<number>`coalesce(sum(${scans.points}), 0)::int`, failed: sql<number>`count(*) filter (where ${scans.result} <> 'added')::int` })
      .from(scans)
      .where(eq(scans.day, day));
    const [wd] = await db
      .select({ n: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(${withdrawals.amount}), 0)::int` })
      .from(withdrawals)
      .where(inArray(withdrawals.status, ['requested', 'held']));
    const [toPay] = await db.select({ n: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(${withdrawals.amount}), 0)::int` }).from(withdrawals).where(eq(withdrawals.status, 'approved'));
    const [booked] = await db.select({ n: sql<number>`count(*)::int` }).from(giftOrders).where(inArray(giftOrders.step, ['booked', 'packed']));
    const [flags] = await db.select({ n: sql<number>`count(*)::int` }).from(fraudFlags).where(eq(fraudFlags.status, 'open'));
    const [photos] = await db.select({ n: sql<number>`count(*)::int` }).from(streakPhotos).where(eq(streakPhotos.status, 'pending'));
    const [newUsers] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(gte(users.createdAt, new Date(`${day}T00:00:00+05:30`)));
    const owner = req.staff.role === 'owner';
    const [liab] = owner ? await db.select({ points: sql<number>`coalesce(sum(${users.points}), 0)::int` }).from(users) : [null];
    return {
      day,
      scans: sc,
      newApplicators: newUsers.n,
      withdrawalsWaiting: wd,
      withdrawalsToPay: toPay,
      giftsToShip: booked.n,
      openFlags: flags.n,
      streakPhotosWaiting: photos.n,
      approvalsBadge: wd.n + photos.n,
      // Owners only: ₹ liability = all applicator points (1 pt = ₹1).
      pointsLiability: liab?.points ?? null,
    };
  });

  app.get('/settings', { preHandler: requireStaff('accounts', 'factory', 'helpline', 'ops') }, async () => ({ settings: await getSettings(db), defaults: DEFAULT_SETTINGS }));

  app.put('/settings/:key', { preHandler: requireStaff('owner'), schema: { params: z.object({ key: z.string() }), body: z.object({ value: z.unknown() }) } }, async (req) => {
    const key = req.params.key as SettingsKey;
    const shape = SettingsSchema.shape as Record<string, z.ZodType>;
    if (!shape[key]) throw notFound('Setting');
    const parsed = shape[key].safeParse(req.body.value);
    if (!parsed.success) throw badRequest('invalid_setting', parsed.error.issues[0]?.message ?? 'Invalid value');
    const before = (await getSettings(db))[key];
    await db
      .insert(settings)
      .values({ key, value: parsed.data as object, updatedBy: req.staff.id, updatedAt: now() })
      .onConflictDoUpdate({ target: settings.key, set: { value: parsed.data as object, updatedBy: req.staff.id, updatedAt: now() } });
    clearSettingsCache(db);
    await audit(db, staffActor(req), 'setting_update', 'setting', key, before, parsed.data);
    return { key, value: parsed.data };
  });

  // D9d: append-only audit log, newest first. Owners see everything; Accounts
  // (Ankit) see money rows only — withdrawals and balance adjustments.
  const MONEY_ACTIONS = ['adjust_balance', 'kyc_ok', 'pan_view'];
  app.get(
    '/audit',
    {
      preHandler: requireStaff('accounts'),
      schema: { querystring: z.object({ entity: z.string().max(40).optional(), entityId: z.string().max(60).optional(), from: z.iso.datetime().optional(), to: z.iso.datetime().optional(), ...PageQuery }) },
    },
    async (req) => {
      const q = req.query;
      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            req.staff.role === 'owner' ? undefined : or(eq(auditLog.entity, 'withdrawal'), inArray(auditLog.action, MONEY_ACTIONS)),
            q.entity ? eq(auditLog.entity, q.entity) : undefined,
            q.entityId ? eq(auditLog.entityId, q.entityId) : undefined,
            q.from ? gte(auditLog.createdAt, new Date(q.from)) : undefined,
            q.to ? lt(auditLog.createdAt, new Date(q.to)) : undefined,
            idCursor(auditLog.id, q.cursor),
          ),
        )
        .orderBy(desc(auditLog.id))
        .limit(q.limit + 1);
      return page(rows, q.limit, (r) => String(r.id));
    },
  );

  // Settings → Staff logins (owners).
  const StaffBody = z.object({
    loginId: z.string().trim().toLowerCase().regex(/^[a-z0-9._@+-]{3,40}$/), // staff email (older logins: a plain ID)
    name: z.string().trim().min(2).max(60),
    role: z.enum(['owner', 'accounts', 'factory', 'helpline', 'ops']),
    mobile: z.string().regex(/^\d{10}$/).optional(),
    password: z.string().min(10).max(72),
    pin: z.string().regex(/^\d{4}$/),
  });

  app.get('/staff', { preHandler: requireStaff('owner') }, async () => ({
    staff: await db.select({ id: staff.id, loginId: staff.loginId, name: staff.name, role: staff.role, mobile: staff.mobile, active: staff.active, lockedUntil: staff.lockedUntil, createdAt: staff.createdAt }).from(staff).orderBy(staff.name),
  }));

  app.post('/staff', { preHandler: requireStaff('owner'), schema: { body: StaffBody } }, async (req) => {
    const b = req.body;
    const [s] = await db
      .insert(staff)
      .values({ loginId: b.loginId, name: b.name, role: b.role, mobile: b.mobile ?? null, passwordHash: await hashSecret(b.password), pinHash: await hashSecret(b.pin) })
      .onConflictDoNothing()
      .returning({ id: staff.id, loginId: staff.loginId });
    if (!s) throw conflict('exists', 'This admin ID is taken');
    await audit(db, staffActor(req), 'staff_create', 'staff', s.id, null, { loginId: b.loginId, role: b.role });
    return s;
  });

  app.patch(
    '/staff/:id',
    {
      preHandler: requireStaff('owner'),
      schema: { params: z.object({ id: z.uuid() }), body: z.object({ role: StaffBody.shape.role, active: z.boolean(), password: StaffBody.shape.password, pin: StaffBody.shape.pin, unlock: z.literal(true) }).partial() },
    },
    async (req) => {
      const b = req.body;
      const set: Partial<typeof staff.$inferInsert> = {};
      if (b.role) set.role = b.role;
      if (b.active !== undefined) set.active = b.active;
      if (b.password) set.passwordHash = await hashSecret(b.password);
      if (b.pin) set.pinHash = await hashSecret(b.pin);
      if (b.unlock) Object.assign(set, { lockedUntil: null, failedLogins: 0 });
      const [s] = await db.update(staff).set(set).where(eq(staff.id, req.params.id)).returning({ id: staff.id });
      if (!s) throw notFound('Staff');
      if (b.active === false || b.password) await revokeAllFor(db, 'staff', s.id, now());
      await audit(db, staffActor(req), 'staff_update', 'staff', s.id, null, { ...b, password: b.password ? '***' : undefined, pin: b.pin ? '***' : undefined });
      return { ok: true };
    },
  );

  // D9a Products & TDS: info only (no points, no prices). A new TDS PDF replaces the old one.
  app.get('/products', { preHandler: requireStaff('factory', 'helpline') }, async () => ({ products: await db.select().from(products).orderBy(products.sort) }));

  app.put(
    '/products/:id',
    {
      preHandler: requireStaff('owner'),
      schema: {
        params: z.object({ id: z.string().regex(/^[a-z0-9-]{2,40}$/) }),
        body: z.object({
          name: z.string().trim().min(2).max(80),
          category: z.string().trim().min(2).max(30),
          data: z.record(z.string(), z.unknown()),
          sort: z.number().int().default(0),
          active: z.boolean().default(true),
          tdsObject: z.string().startsWith('tds/').max(200).optional(),
          tdsBytes: z.number().int().positive().optional(),
        }),
      },
    },
    async (req) => {
      const { tdsObject, tdsBytes, ...rest } = req.body;
      if (tdsObject && !(await store.exists(tdsObject))) throw badRequest('tds_missing', 'Upload the PDF first');
      const tds = tdsObject ? { tdsObject, tdsBytes: tdsBytes ?? null, tdsUpdatedAt: now() } : {};
      const [before] = await db.select().from(products).where(eq(products.id, req.params.id));
      const [after] = await db
        .insert(products)
        .values({ id: req.params.id, ...rest, ...tds })
        .onConflictDoUpdate({ target: products.id, set: { ...rest, ...tds } })
        .returning();
      await audit(db, staffActor(req), before ? 'product_update' : 'product_create', 'product', after.id, before ?? null, after);
      return after;
    },
  );

  // Payment screenshots, delivery photos, TDS PDFs → signed PUT URL.
  app.post(
    '/uploads',
    {
      preHandler: requireStaff('accounts', 'factory'),
      schema: { body: z.object({ purpose: z.enum(['payment_proof', 'delivery_photo', 'tds']), contentType: z.enum([...IMAGE_TYPES, 'application/pdf']) }) },
    },
    async (req) => {
      const { purpose, contentType } = req.body;
      if ((purpose === 'tds') !== (contentType === 'application/pdf')) throw badRequest('bad_type', purpose === 'tds' ? 'Upload a PDF' : 'Upload a photo');
      const object = `${purpose}/${istDay(now())}/${randomUUID()}.${ext(contentType)}`;
      const signed = await store.signedPut(object, contentType, 20 * 1024 * 1024);
      return { object, ...signed, expiresAt: signed.expiresAt.toISOString() };
    },
  );
};

export default routes;
