import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { giftOrders, gifts, users } from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { post } from '../../lib/ledger.js';
import { notify, queueWhatsApp } from '../../lib/notify.js';
import { requireStaff, staffActor } from '../../plugins/auth.js';
import { orderView, parseOrderId } from '../gifts.js';
import { idCursor, page, PageQuery } from '../../lib/page.js';

// D5 / M4 Gifts & courier: Booked → Packed → Shipped (courier + AWB) →
// Delivered (photo + who received). Each step updates the app + WhatsApp.
const GiftBody = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().trim().min(2).max(80),
  runsPrice: z.number().int().positive(),
  stock: z.number().int().min(0).nullable().default(null),
  active: z.boolean().default(true),
  photos: z.array(z.string().max(300)).max(4).default([]),
  sizes: z.array(z.string().max(20)).max(10).default([]),
  marketValueInr: z.number().int().min(0).nullable().default(null),
  sort: z.number().int().default(0),
});
const Id = z.object({ id: z.string() });

async function load(db: Db, id: string) {
  const [o] = await db.select().from(giftOrders).where(eq(giftOrders.id, parseOrderId(id))).for('update');
  if (!o) throw notFound('Order');
  const [g] = await db.select({ name: gifts.name }).from(gifts).where(eq(gifts.id, o.giftId));
  return { o, giftName: g.name };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, store, now } = app.deps;
  const ship = requireStaff('factory');

  app.get('/gifts', { preHandler: requireStaff('factory', 'accounts', 'helpline') }, async () => ({
    gifts: await db.select().from(gifts).orderBy(asc(gifts.sort), asc(gifts.runsPrice)),
  }));

  app.post('/gifts', { preHandler: requireStaff('owner'), schema: { body: GiftBody } }, async (req) => {
    const [g] = await db.insert(gifts).values(req.body).onConflictDoNothing().returning();
    if (!g) throw conflict('exists', 'A gift with this id already exists');
    await audit(db, staffActor(req), 'gift_create', 'gift', g.id, null, g);
    return g;
  });

  app.patch('/gifts/:id', { preHandler: requireStaff('owner'), schema: { params: Id, body: GiftBody.omit({ id: true }).partial() } }, async (req) => {
    const [before] = await db.select().from(gifts).where(eq(gifts.id, req.params.id));
    if (!before) throw notFound('Gift');
    const [after] = await db.update(gifts).set(req.body).where(eq(gifts.id, before.id)).returning();
    await audit(db, staffActor(req), 'gift_update', 'gift', before.id, before, after);
    return after;
  });

  app.get(
    '/gift-orders',
    { preHandler: requireStaff('factory', 'accounts', 'helpline'), schema: { querystring: z.object({ step: z.enum(['booked', 'packed', 'shipped', 'delivered', 'cancelled']).default('booked'), ...PageQuery }) } },
    async (req) => {
      const t = now();
      const done = req.query.step === 'delivered' || req.query.step === 'cancelled';
      const counts = await db.select({ step: giftOrders.step, n: sql<number>`count(*)::int` }).from(giftOrders).groupBy(giftOrders.step);
      const rows = await db
        .select({ o: giftOrders, giftName: gifts.name, name: users.name, mobile: users.mobile })
        .from(giftOrders)
        .innerJoin(gifts, eq(gifts.id, giftOrders.giftId))
        .innerJoin(users, eq(users.id, giftOrders.userId))
        .where(and(eq(giftOrders.step, req.query.step), done ? idCursor(giftOrders.id, req.query.cursor) : undefined))
        .orderBy(done ? desc(giftOrders.id) : asc(giftOrders.bookedAt))
        .limit(done ? req.query.limit + 1 : 1000);
      const p = done ? page(rows, req.query.limit, (r) => String(r.o.id)) : { rows, nextCursor: null };
      return {
        counts: Object.fromEntries(counts.map((c) => [c.step, c.n])),
        nextCursor: p.nextCursor,
        rows: await Promise.all(
          p.rows.map(async (r) => ({
            ...(await orderView(r.o, r.giftName, store)),
            applicator: { name: r.name, mobile: r.mobile },
            // M4: orders waiting in Booked for over 2 days get an orange border.
            stale: r.o.step === 'booked' && t.getTime() - r.o.bookedAt.getTime() > 2 * 86_400_000,
          })),
        ),
      };
    },
  );

  app.post('/gift-orders/:id/pack', { preHandler: ship, schema: { params: Id } }, async (req) => {
    const t = now();
    return db.transaction(async (tx) => {
      const { o, giftName } = await load(tx, req.params.id);
      if (o.step !== 'booked') throw conflict('bad_step', `Order is ${o.step}`);
      await tx.update(giftOrders).set({ step: 'packed', packedAt: t }).where(eq(giftOrders.id, o.id));
      await notify(tx, o.userId, { kind: 'gifts', title: 'Your gift is packed', body: giftName, art: 'package', link: { route: 'MyGiftDetail', params: { orderId: `G-${o.id}` } } });
      await queueWhatsApp(tx, o.userId, 'gift_packed', { gift: giftName });
      await audit(tx, staffActor(req), 'order_pack', 'gift_order', o.id);
      return { ok: true };
    });
  });

  app.post(
    '/gift-orders/:id/ship',
    {
      preHandler: ship,
      schema: {
        params: Id,
        body: z.object({
          courierName: z.string().trim().min(2).max(40),
          awb: z.string().trim().min(4).max(40),
          trackingUrl: z.url().optional(),
          eta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }),
      },
    },
    async (req) => {
      const t = now();
      return db.transaction(async (tx) => {
        const { o, giftName } = await load(tx, req.params.id);
        if (o.step !== 'packed' && o.step !== 'booked') throw conflict('bad_step', `Order is ${o.step}`);
        await tx
          .update(giftOrders)
          .set({ step: 'shipped', packedAt: o.packedAt ?? t, shippedAt: t, courierName: req.body.courierName, awb: req.body.awb, trackingUrl: req.body.trackingUrl ?? null, eta: req.body.eta ?? null })
          .where(eq(giftOrders.id, o.id));
        await notify(tx, o.userId, { kind: 'gifts', title: 'Your gift is on the way', body: `${giftName} · AWB ${req.body.awb} · ${req.body.courierName}`, art: 'delivery-truck', link: { route: 'MyGiftDetail', params: { orderId: `G-${o.id}` } } });
        await queueWhatsApp(tx, o.userId, 'gift_shipped', { gift: giftName, courier: req.body.courierName, awb: req.body.awb });
        await audit(tx, staffActor(req), 'order_ship', 'gift_order', o.id, null, req.body);
        return { ok: true };
      });
    },
  );

  app.post(
    '/gift-orders/:id/deliver',
    { preHandler: ship, schema: { params: Id, body: z.object({ photoObject: z.string().startsWith('delivery_photo/').max(200), receivedBy: z.string().trim().min(2).max(60) }) } },
    async (req) => {
      const t = now();
      if (!(await store.exists(req.body.photoObject))) throw badRequest('photo_missing', 'Upload the delivery photo first');
      return db.transaction(async (tx) => {
        const { o, giftName } = await load(tx, req.params.id);
        if (o.step !== 'shipped') throw conflict('bad_step', `Order is ${o.step}`);
        await tx.update(giftOrders).set({ step: 'delivered', deliveredAt: t, deliveryPhotoObject: req.body.photoObject, receivedBy: req.body.receivedBy }).where(eq(giftOrders.id, o.id));
        const date = t.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
        await notify(tx, o.userId, { kind: 'gifts', title: 'Gift delivered', body: `${giftName} · ${date}`, art: 'check-mark-button', link: { route: 'MyGiftDetail', params: { orderId: `G-${o.id}` } } });
        await queueWhatsApp(tx, o.userId, 'gift_delivered', { gift: giftName, date });
        await audit(tx, staffActor(req), 'order_deliver', 'gift_order', o.id, null, { receivedBy: req.body.receivedBy });
        return { ok: true };
      });
    },
  );

  // Cancel before delivery: runs and stock go back (D5).
  app.post('/gift-orders/:id/cancel', { preHandler: requireStaff('owner'), schema: { params: Id, body: z.object({ reason: z.string().min(3).max(200) }) } }, async (req) => {
    const t = now();
    return db.transaction(async (tx) => {
      const { o, giftName } = await load(tx, req.params.id);
      if (o.step === 'delivered' || o.step === 'cancelled') throw conflict('bad_step', `Order is ${o.step}`);
      await tx.update(giftOrders).set({ step: 'cancelled', cancelledAt: t }).where(eq(giftOrders.id, o.id));
      await tx.update(gifts).set({ stock: sql`case when ${gifts.stock} is null then null else ${gifts.stock} + 1 end` }).where(eq(gifts.id, o.giftId));
      await post(tx, { at: t, userId: o.userId, wallet: 'runs', kind: 'gift_refund', amount: o.runs, title: `Gift cancelled: ${giftName}`, sub: `G-${o.id} · runs back` });
      await notify(tx, o.userId, { kind: 'gifts', title: 'Gift order cancelled', body: `${req.body.reason} · ${o.runs} runs are back`, art: 'wrapped-gift' });
      await audit(tx, staffActor(req), 'order_cancel', 'gift_order', o.id, null, { reason: req.body.reason });
      return { ok: true };
    });
  });
};

export default routes;
