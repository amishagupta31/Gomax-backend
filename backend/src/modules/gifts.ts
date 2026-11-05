import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { giftOrders, gifts } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { post } from '../lib/ledger.js';
import { notify } from '../lib/notify.js';
import type { FileStore } from '../lib/storage.js';
import { requireUser } from '../plugins/auth.js';

// B2 gifts. Runs are taken when the applicator books and returned on cancel (D5).
export const AddressSchema = z.object({
  name: z.string().trim().min(2).max(80),
  mobile: z.string().regex(/^\d{10}$/),
  street: z.string().trim().min(5).max(200),
  city: z.string().trim().min(2).max(60),
  pin: z.string().regex(/^\d{6}$/, '6-digit PIN code'),
});

export const giftView = (g: typeof gifts.$inferSelect) => ({
  id: g.id,
  name: g.name,
  runs: g.runsPrice,
  inStock: g.stock == null || g.stock > 0,
  photos: g.photos,
  sizes: g.sizes,
});

export async function orderView(o: typeof giftOrders.$inferSelect, giftName: string, store: FileStore) {
  return {
    id: `G-${o.id}`,
    giftId: o.giftId,
    giftName,
    runs: o.runs,
    size: o.size,
    step: o.step,
    dates: {
      booked: o.bookedAt.toISOString(),
      packed: o.packedAt?.toISOString() ?? null,
      shipped: o.shippedAt?.toISOString() ?? null,
      delivered: o.deliveredAt?.toISOString() ?? null,
      cancelled: o.cancelledAt?.toISOString() ?? null,
    },
    eta: o.eta,
    courier: o.awb ? { name: o.courierName, awb: o.awb, url: o.trackingUrl } : null,
    receivedBy: o.receivedBy,
    deliveryPhotoUrl: o.deliveryPhotoObject ? await store.signedGet(o.deliveryPhotoObject) : null,
    address: o.address,
  };
}

export const parseOrderId = (id: string) => {
  const n = Number(id.replace(/^G-/i, ''));
  if (!Number.isInteger(n) || n <= 0) throw notFound('Order');
  return n;
};

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, store, now } = app.deps;

  app.get('/gifts', { preHandler: requireUser }, async () => {
    const rows = await db.select().from(gifts).where(eq(gifts.active, true)).orderBy(asc(gifts.runsPrice), asc(gifts.sort));
    return { gifts: rows.map(giftView) };
  });

  app.post(
    '/gift-orders',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { body: z.object({ giftId: z.string().max(40), size: z.string().max(20).optional(), address: AddressSchema }) },
    },
    async (req) => {
      const { giftId, size, address } = req.body;
      const t = now();
      const o = await db.transaction(async (tx) => {
        const [g] = await tx.select().from(gifts).where(eq(gifts.id, giftId)).for('update');
        if (!g || !g.active) throw notFound('Gift');
        if (g.stock != null && g.stock <= 0) throw conflict('out_of_stock', 'This gift is out of stock');
        if (g.sizes.length && (!size || !g.sizes.includes(size))) throw badRequest('size_required', 'Pick a size');
        if (g.stock != null) await tx.update(gifts).set({ stock: sql`${gifts.stock} - 1` }).where(eq(gifts.id, g.id));
        const [order] = await tx.insert(giftOrders).values({ userId: req.userId, giftId: g.id, size: size ?? null, runs: g.runsPrice, address, bookedAt: t }).returning();
        await post(tx, { at: t, userId: req.userId, wallet: 'runs', kind: 'gift', amount: -g.runsPrice, title: `Gift booked: ${g.name}`, sub: `Order G-${order.id}`, ref: `gift_order:${order.id}` });
        await notify(tx, req.userId, { kind: 'gifts', title: 'Gift booked', body: `${g.name} · we will pack it in 2–3 days`, art: 'wrapped-gift', link: { route: 'MyGiftDetail', params: { orderId: `G-${order.id}` } } });
        return { order, name: g.name };
      });
      return orderView(o.order, o.name, store);
    },
  );

  app.get('/gift-orders', { preHandler: requireUser }, async (req) => {
    const rows = await db
      .select({ o: giftOrders, name: gifts.name })
      .from(giftOrders)
      .innerJoin(gifts, eq(gifts.id, giftOrders.giftId))
      .where(eq(giftOrders.userId, req.userId))
      .orderBy(desc(giftOrders.bookedAt));
    return { orders: await Promise.all(rows.map((r) => orderView(r.o, r.name, store))) };
  });

  app.get('/gift-orders/:id', { preHandler: requireUser, schema: { params: z.object({ id: z.string() }) } }, async (req) => {
    const [r] = await db
      .select({ o: giftOrders, name: gifts.name })
      .from(giftOrders)
      .innerJoin(gifts, eq(gifts.id, giftOrders.giftId))
      .where(and(eq(giftOrders.id, parseOrderId(req.params.id)), eq(giftOrders.userId, req.userId)));
    if (!r) throw notFound('Order');
    return orderView(r.o, r.name, store);
  });

};

export default routes;
