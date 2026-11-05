import { and, desc, eq, gte, ilike, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { couponBatches, coupons, fraudFlags, scans, users } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { adminRef, generateCode, normalizeCode } from '../../lib/codes.js';
import { audit } from '../../lib/audit.js';
import { requireStaff, staffActor } from '../../plugins/auth.js';
import { couponSheetPdf } from '../../lib/printPdf.js';
import { idCursor, page, PageQuery } from '../../lib/page.js';

// D2 Coupons — make, print, track · D3 Scans log, lookup, flags.
const maskMobile = (m: string) => `${m.slice(0, 2)}••••••${m.slice(-2)}`;

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, now } = app.deps;

  app.get('/coupon-batches', { preHandler: requireStaff('factory', 'helpline', 'accounts') }, async () => {
    const rows = await db
      .select({
        b: couponBatches,
        scanned: sql<number>`(select count(*)::int from ${coupons} c where c.batch_id = ${couponBatches.id} and c.scanned_by is not null)`,
      })
      .from(couponBatches)
      .orderBy(desc(couponBatches.id));
    return {
      batches: rows.map(({ b, scanned }) => ({
        ...b,
        scanned,
        progress: scanned === 0 ? 'none' : scanned >= b.quantity ? 'fully_scanned' : 'partly_scanned',
      })),
    };
  });

  // D2b–c: owners create a batch; codes are generated here, unique across all batches.
  app.post(
    '/coupon-batches',
    {
      preHandler: requireStaff('owner'),
      schema: {
        body: z.object({
          valuePoints: z.number().int().min(1).max(1000),
          quantity: z.number().int().min(1).max(100_000),
          line: z.string().trim().max(20).default('standard'),
          validMonths: z.number().int().min(1).max(36).default(12),
          note: z.string().max(200).optional(),
          /** D2b: optional area (state / district) this batch goes to — reports only. */
          area: z.string().trim().max(40).optional(),
        }),
      },
    },
    async (req) => {
      const b = req.body;
      const t = now();
      const expiresAt = new Date(t);
      expiresAt.setMonth(expiresAt.getMonth() + b.validMonths);
      const batch = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(couponBatches)
          .values({ ref: `TMP-${t.getTime() % 1e6}`, valuePoints: b.valuePoints, quantity: b.quantity, line: b.line, expiresAt, note: b.note ?? null, area: b.area || null, createdBy: req.staff.id })
          .returning();
        const ref = `B-${String(row.id).padStart(4, '0')}`;
        await tx.update(couponBatches).set({ ref }).where(eq(couponBatches.id, row.id));
        let serial = 1;
        while (serial <= b.quantity) {
          const chunk = Math.min(1000, b.quantity - serial + 1);
          const values = Array.from({ length: chunk }, (_, i) => ({ code: generateCode(), batchId: row.id, serial: serial + i }));
          const inserted = await tx.insert(coupons).values(values).onConflictDoNothing({ target: coupons.code }).returning({ serial: coupons.serial });
          // A code collision drops that row; regenerate only the missing serials.
          const got = new Set(inserted.map((r) => r.serial));
          for (const v of values.filter((x) => !got.has(x.serial))) {
            for (;;) {
              const ok = await tx.insert(coupons).values({ ...v, code: generateCode() }).onConflictDoNothing({ target: coupons.code }).returning({ id: coupons.id });
              if (ok.length) break;
            }
          }
          serial += chunk;
        }
        await audit(tx, staffActor(req), 'create_batch', 'coupon_batch', row.id, null, { ref, ...b });
        return { ...row, ref };
      });
      return batch;
    },
  );

  // D2d: Generated → Printed → In market; blocking a whole batch (lost / stolen).
  app.patch(
    '/coupon-batches/:id',
    {
      preHandler: requireStaff('factory'),
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ status: z.enum(['printed', 'in_market', 'blocked']), reason: z.string().max(200).optional() }),
      },
    },
    async (req) => {
      const { status, reason } = req.body;
      if (status === 'blocked' && req.staff.role !== 'owner') throw forbidden('Only owners can block a batch');
      if (status === 'blocked' && !reason) throw badRequest('reason_required', 'Give a reason');
      const [before] = await db.select().from(couponBatches).where(eq(couponBatches.id, req.params.id));
      if (!before) throw notFound('Batch');
      const order = ['generated', 'printed', 'in_market'];
      if (status !== 'blocked' && order.indexOf(status) <= order.indexOf(before.status)) throw conflict('bad_step', `Batch is already ${before.status}`);
      const t = now();
      const [after] = await db
        .update(couponBatches)
        .set({
          status,
          printedAt: status === 'printed' ? t : before.printedAt,
          inMarketAt: status === 'in_market' ? t : before.inMarketAt,
          blockedReason: status === 'blocked' ? reason : before.blockedReason,
        })
        .where(eq(couponBatches.id, before.id))
        .returning();
      await audit(db, staffActor(req), `batch_${status}`, 'coupon_batch', before.id, { status: before.status }, { status, reason });
      return after;
    },
  );

  // D2: print/CSV export — logged.
  app.get('/coupon-batches/:id/export.csv', { preHandler: requireStaff('factory'), schema: { params: z.object({ id: z.coerce.number().int() }) } }, async (req, reply) => {
    const [b] = await db.select().from(couponBatches).where(eq(couponBatches.id, req.params.id));
    if (!b) throw notFound('Batch');
    const rows = await db.select({ code: coupons.code, serial: coupons.serial }).from(coupons).where(eq(coupons.batchId, b.id)).orderBy(coupons.serial);
    await audit(db, staffActor(req), 'export_batch', 'coupon_batch', b.id);
    const csv = ['code,admin_ref,value_points,expires', ...rows.map((r) => `${r.code},${adminRef(b.ref, r.serial)},${b.valuePoints},${b.expiresAt.toISOString().slice(0, 10)}`)].join('\n');
    return reply.header('content-type', 'text/csv').header('content-disposition', `attachment; filename="${b.ref}.csv"`).send(csv);
  });

  // D2d: print-ready PDF — 48 coupons per A4 with cut marks. Logged like the CSV.
  app.get('/coupon-batches/:id/print.pdf', { preHandler: requireStaff('factory'), schema: { params: z.object({ id: z.coerce.number().int() }) } }, async (req, reply) => {
    const [b] = await db.select().from(couponBatches).where(eq(couponBatches.id, req.params.id));
    if (!b) throw notFound('Batch');
    if (b.status === 'blocked') throw conflict('blocked', 'This batch is blocked');
    const rows = await db.select({ code: coupons.code, serial: coupons.serial }).from(coupons).where(eq(coupons.batchId, b.id)).orderBy(coupons.serial);
    const pdf = await couponSheetPdf(b, rows.map((r) => ({ code: r.code, ref: adminRef(b.ref, r.serial) })));
    await audit(db, staffActor(req), 'export_batch_pdf', 'coupon_batch', b.id, null, { pages: Math.ceil(rows.length / 48) });
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${b.ref}.pdf"`).send(pdf);
  });

  app.post(
    '/coupons/:code/block',
    { preHandler: requireStaff('owner'), schema: { params: z.object({ code: z.string() }), body: z.object({ reason: z.string().min(3).max(200) }) } },
    async (req) => {
      const code = normalizeCode(req.params.code);
      if (!code) throw notFound('Coupon');
      const [c] = await db.update(coupons).set({ blocked: true }).where(eq(coupons.code, code)).returning();
      if (!c) throw notFound('Coupon');
      await audit(db, staffActor(req), 'block_coupon', 'coupon', code, null, { reason: req.body.reason });
      return { ok: true };
    },
  );

  // D3a / M3: coupon lookup — the full story of one code, for disputes.
  app.get('/coupons/:code', { preHandler: requireStaff('helpline', 'accounts', 'factory') }, async (req) => {
    const code = normalizeCode((req.params as { code: string }).code);
    if (!code) throw notFound('Coupon');
    const [c] = await db
      .select({ coupon: coupons, batch: couponBatches })
      .from(coupons)
      .innerJoin(couponBatches, eq(couponBatches.id, coupons.batchId))
      .where(eq(coupons.code, code));
    if (!c) throw notFound('Coupon');
    const tries = await db
      .select({ s: scans, name: users.name, mobile: users.mobile })
      .from(scans)
      .innerJoin(users, eq(users.id, scans.userId))
      .where(eq(scans.code, code))
      .orderBy(desc(scans.scannedAt));
    const fullMobile = req.staff.role === 'owner' || req.staff.role === 'accounts';
    const winner = tries.find((x) => x.s.result === 'added');
    return {
      code,
      adminRef: adminRef(c.batch.ref, c.coupon.serial),
      value: c.batch.valuePoints,
      batch: { id: c.batch.id, ref: c.batch.ref, status: c.batch.status, expiresAt: c.batch.expiresAt.toISOString(), line: c.batch.line },
      status: c.coupon.blocked ? 'blocked' : c.coupon.scannedBy ? (tries.filter((x) => x.s.result === 'already_used').length ? 'repeat_try_blocked' : 'scanned') : 'fresh',
      scannedBy: winner ? { name: winner.name, mobile: fullMobile ? winner.mobile : maskMobile(winner.mobile), at: winner.s.scannedAt.toISOString(), lat: winner.s.lat, lng: winner.s.lng, source: winner.s.source } : null,
      attempts: tries.map((x) => ({
        result: x.s.result,
        name: x.name,
        mobile: fullMobile ? x.mobile : maskMobile(x.mobile),
        at: x.s.scannedAt.toISOString(),
        source: x.s.source,
        lat: x.s.lat,
        lng: x.s.lng,
        device: x.s.deviceModel,
      })),
    };
  });

  // D3b: all scans with filters; search by code, mobile or name.
  app.get(
    '/scans',
    {
      preHandler: requireStaff('helpline', 'accounts', 'factory'),
      schema: {
        querystring: z.object({
          from: z.iso.datetime().optional(),
          to: z.iso.datetime().optional(),
          result: z.enum(['added', 'already_used', 'expired', 'not_active', 'wrong_code', 'blocked']).optional(),
          source: z.enum(['scan', 'typed', 'offline']).optional(),
          q: z.string().trim().max(60).optional(),
          ...PageQuery,
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const rows = await db
        .select({ s: scans, name: users.name, mobile: users.mobile })
        .from(scans)
        .innerJoin(users, eq(users.id, scans.userId))
        .where(
          and(
            q.from ? gte(scans.scannedAt, new Date(q.from)) : undefined,
            q.to ? lt(scans.scannedAt, new Date(q.to)) : undefined,
            q.result ? eq(scans.result, q.result) : undefined,
            q.source ? eq(scans.source, q.source) : undefined,
            idCursor(scans.id, q.cursor),
            q.q ? or(ilike(users.name, `%${q.q}%`), eq(users.mobile, q.q.replace(/\D/g, '').slice(-10)), eq(scans.code, normalizeCode(q.q) ?? q.q.toUpperCase())) : undefined,
          ),
        )
        .orderBy(desc(scans.id))
        .limit(q.limit + 1);
      const p = page(rows, q.limit, (r) => String(r.s.id));
      return { rows: p.rows.map((r) => ({ ...r.s, name: r.name, mobile: r.mobile })), nextCursor: p.nextCursor };
    },
  );

  // D3c: duplicate & fraud flags; clearing the last open flag releases the cash hold.
  app.get('/fraud-flags', { preHandler: requireStaff('helpline', 'accounts'), schema: { querystring: z.object({ status: z.enum(['open', 'cleared', 'confirmed']).default('open'), ...PageQuery }) } }, async (req) => {
    const rows = await db
      .select({ f: fraudFlags, name: users.name, mobile: users.mobile })
      .from(fraudFlags)
      .innerJoin(users, eq(users.id, fraudFlags.userId))
      .where(and(eq(fraudFlags.status, req.query.status), idCursor(fraudFlags.id, req.query.cursor)))
      .orderBy(desc(fraudFlags.id))
      .limit(req.query.limit + 1);
    const p = page(rows, req.query.limit, (r) => String(r.f.id));
    return { flags: p.rows.map((r) => ({ ...r.f, name: r.name, mobile: r.mobile })), nextCursor: p.nextCursor };
  });

  app.post(
    '/fraud-flags/:id/decide',
    { preHandler: requireStaff('owner'), schema: { params: z.object({ id: z.coerce.number().int() }), body: z.object({ decision: z.enum(['cleared', 'confirmed']), note: z.string().max(300).optional() }) } },
    async (req) => {
      const t = now();
      return db.transaction(async (tx) => {
        const [f] = await tx
          .update(fraudFlags)
          .set({ status: req.body.decision, decidedBy: req.staff.id, decidedAt: t })
          .where(and(eq(fraudFlags.id, req.params.id), eq(fraudFlags.status, 'open')))
          .returning();
        if (!f) throw notFound('Open flag');
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(fraudFlags)
          .where(and(eq(fraudFlags.userId, f.userId), eq(fraudFlags.status, 'open')));
        if (n === 0 && req.body.decision === 'cleared') await tx.update(users).set({ cashHold: false }).where(eq(users.id, f.userId));
        await audit(tx, staffActor(req), `flag_${req.body.decision}`, 'fraud_flag', f.id, null, { note: req.body.note });
        return { ok: true, cashHold: !(n === 0 && req.body.decision === 'cleared') };
      });
    },
  );
};

export default routes;
