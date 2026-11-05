import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { products } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { requireUser } from '../plugins/auth.js';

// C1 Products — information only: no points, no prices, no dealer info.
const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, store } = app.deps;

  const view = (p: typeof products.$inferSelect) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    ...p.data,
    tds: p.tdsObject ? { bytes: p.tdsBytes, updatedAt: p.tdsUpdatedAt?.toISOString() ?? null } : null,
  });

  app.get('/products', { preHandler: requireUser, schema: { querystring: z.object({ category: z.string().max(30).optional() }) } }, async (req) => {
    const rows = await db
      .select()
      .from(products)
      .where(and(eq(products.active, true), req.query.category ? eq(products.category, req.query.category) : undefined))
      .orderBy(asc(products.sort));
    return { products: rows.map(view) };
  });

  app.get('/products/:id', { preHandler: requireUser, schema: { params: z.object({ id: z.string().max(40) }) } }, async (req) => {
    const [p] = await db.select().from(products).where(and(eq(products.id, req.params.id), eq(products.active, true)));
    if (!p) throw notFound('Product');
    return view(p);
  });

  // C1-03: TDS (technical data sheet) PDF via a 1-hour signed link.
  app.get('/products/:id/tds', { preHandler: requireUser, schema: { params: z.object({ id: z.string().max(40) }) } }, async (req) => {
    const [p] = await db.select().from(products).where(eq(products.id, req.params.id));
    if (!p?.tdsObject) throw notFound('Data sheet');
    return { url: await store.signedGet(p.tdsObject), bytes: p.tdsBytes, updatedAt: p.tdsUpdatedAt?.toISOString() ?? null };
  });
};

export default routes;
