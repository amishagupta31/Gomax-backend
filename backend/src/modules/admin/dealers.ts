import { randomInt } from 'node:crypto';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { dealers } from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { hashSecret } from '../../lib/crypto.js';
import { uniqueViolation } from '../../lib/pgerrors.js';
import { requireStaff, staffActor } from '../../plugins/auth.js';

// D10 Dealers — create login & manage. Dealers cannot sign up: an owner makes a
// Login ID (GMD-<area>-<no>) and a temporary password (must change at first
// login, expires in 7 days if unused). The password is shown once and shared
// on WhatsApp by the admin. Reset password: owners + helpline. Deactivate keeps
// all data and can be undone. Dealer sign-in (their own scans, view only) is phase 2.
const TEMP_DAYS = 7;
const Id = z.object({ id: z.uuid() });
const GST_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const tempPassword = () => Array.from({ length: 10 }, () => PW_ALPHABET[randomInt(PW_ALPHABET.length)]).join('');

const view = (d: typeof dealers.$inferSelect) => ({
  id: d.id,
  loginId: d.loginId,
  firm: d.firm,
  ownerName: d.ownerName,
  mobile: d.mobile,
  gst: d.gst,
  area: d.area,
  areaTeam: d.areaTeam,
  active: d.active,
  deactivatedReason: d.deactivatedReason,
  mustChangePassword: d.mustChangePassword,
  tempPasswordExpiresAt: d.tempPasswordExpiresAt?.toISOString() ?? null,
  lastLoginAt: d.lastLoginAt?.toISOString() ?? null,
  createdAt: d.createdAt.toISOString(),
});

const Body = z.object({
  firm: z.string().trim().min(2).max(80),
  ownerName: z.string().trim().min(2).max(60),
  mobile: z.string().regex(/^[6-9]\d{9}$/, 'WhatsApp mobile, 10 digits'),
  gst: z
    .string()
    .trim()
    .toUpperCase()
    .regex(GST_RE, 'GST number looks wrong (15 characters)')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  area: z.string().trim().toUpperCase().regex(/^[A-Z]{2,5}$/, 'Area code: 2–5 letters, e.g. LDH'),
  areaTeam: z.string().trim().max(60).optional(),
});

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, now } = app.deps;
  const owner = requireStaff('owner');

  app.get(
    '/dealers',
    { preHandler: requireStaff('helpline'), schema: { querystring: z.object({ q: z.string().trim().max(60).optional(), status: z.enum(['all', 'active', 'inactive']).default('all'), area: z.string().trim().toUpperCase().max(5).optional() }) } },
    async (req) => {
      const { q, status, area } = req.query;
      const digits = q?.replace(/\D/g, '') ?? '';
      const rows = await db
        .select()
        .from(dealers)
        .where(
          and(
            status === 'all' ? undefined : eq(dealers.active, status === 'active'),
            area ? eq(dealers.area, area) : undefined,
            q ? or(ilike(dealers.firm, `%${q}%`), ilike(dealers.ownerName, `%${q}%`), ilike(dealers.loginId, `%${q}%`), digits.length >= 4 ? ilike(dealers.mobile, `%${digits}%`) : undefined) : undefined,
          ),
        )
        .orderBy(desc(dealers.createdAt))
        .limit(500);
      return { rows: rows.map(view) };
    },
  );

  app.post('/dealers', { preHandler: owner, schema: { body: Body } }, async (req) => {
    const b = req.body;
    if (b.gst && Number(b.gst.slice(0, 2)) < 1) throw badRequest('bad_gst', 'GST state code looks wrong');
    const password = tempPassword();
    const passwordHash = await hashSecret(password);
    const t = now();
    // Next number in this area; the unique login ID guards against two owners at once.
    for (let attempt = 0; attempt < 5; attempt++) {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(dealers).where(eq(dealers.area, b.area));
      const loginId = `GMD-${b.area}-${String(n + 1 + attempt).padStart(4, '0')}`;
      try {
        const [d] = await db
          .insert(dealers)
          .values({ loginId, firm: b.firm, ownerName: b.ownerName, mobile: b.mobile, gst: b.gst ?? null, area: b.area, areaTeam: b.areaTeam ?? null, passwordHash, tempPasswordExpiresAt: new Date(t.getTime() + TEMP_DAYS * 86_400_000), createdBy: req.staff.id })
          .returning();
        await audit(db, staffActor(req), 'dealer_create', 'dealer', d.id, null, { loginId, firm: b.firm, area: b.area });
        return { dealer: view(d), tempPassword: password };
      } catch (e) {
        if (uniqueViolation(e) === 'dealers_login_id_unique') continue;
        throw e;
      }
    }
    throw conflict('busy', 'Could not make a Login ID. Try again.');
  });

  app.patch('/dealers/:id', { preHandler: owner, schema: { params: Id, body: Body.omit({ area: true }).partial() } }, async (req) => {
    const [before] = await db.select().from(dealers).where(eq(dealers.id, req.params.id));
    if (!before) throw notFound('Dealer');
    const [d] = await db
      .update(dealers)
      .set({ ...req.body, gst: req.body.gst === undefined ? before.gst : req.body.gst, updatedAt: now() })
      .where(eq(dealers.id, before.id))
      .returning();
    await audit(db, staffActor(req), 'dealer_update', 'dealer', d.id, view(before), view(d));
    return view(d);
  });

  app.post('/dealers/:id/reset-password', { preHandler: requireStaff('helpline'), schema: { params: Id } }, async (req) => {
    const password = tempPassword();
    const t = now();
    const [d] = await db
      .update(dealers)
      .set({ passwordHash: await hashSecret(password), mustChangePassword: true, tempPasswordExpiresAt: new Date(t.getTime() + TEMP_DAYS * 86_400_000), updatedAt: t })
      .where(and(eq(dealers.id, req.params.id), eq(dealers.active, true)))
      .returning();
    if (!d) throw notFound('Active dealer');
    await audit(db, staffActor(req), 'dealer_reset_password', 'dealer', d.id);
    return { dealer: view(d), tempPassword: password };
  });

  app.post('/dealers/:id/deactivate', { preHandler: owner, schema: { params: Id, body: z.object({ reason: z.string().trim().min(3).max(200) }) } }, async (req) => {
    const [d] = await db
      .update(dealers)
      .set({ active: false, deactivatedReason: req.body.reason, updatedAt: now() })
      .where(and(eq(dealers.id, req.params.id), eq(dealers.active, true)))
      .returning();
    if (!d) throw notFound('Active dealer');
    await audit(db, staffActor(req), 'dealer_deactivate', 'dealer', d.id, null, { reason: req.body.reason });
    return view(d);
  });

  app.post('/dealers/:id/reactivate', { preHandler: owner, schema: { params: Id } }, async (req) => {
    const [d] = await db
      .update(dealers)
      .set({ active: true, deactivatedReason: null, updatedAt: now() })
      .where(and(eq(dealers.id, req.params.id), eq(dealers.active, false)))
      .returning();
    if (!d) throw notFound('Inactive dealer');
    await audit(db, staffActor(req), 'dealer_reactivate', 'dealer', d.id);
    return view(d);
  });
};

export default routes;
