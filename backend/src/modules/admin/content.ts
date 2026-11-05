import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { contentPages, homeCards } from '../../db/schema.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requireStaff, staffActor } from '../../plugins/auth.js';

// D8a Home content: cards on the app Home (title, text, 3D icon, rule, order,
// live) in 3 languages, plus "How GoMax works" and T&C per language. Owners edit.
export const Lang3 = (max: number) =>
  z.object({ en: z.string().trim().min(1).max(max), hi: z.string().trim().max(max).optional(), pa: z.string().trim().max(max).optional() });
export const CARD_RULES = ['always', 'first_7_days', 'from_2nd_visit', 'date_range'] as const;
export const PAGE_KEYS = ['how_it_works', 'terms'] as const;

const CardBody = z.object({
  title: Lang3(80),
  body: Lang3(300),
  art: z.string().trim().min(2).max(40).default('sparkles'),
  rule: z.enum(CARD_RULES).default('always'),
  startsAt: z.iso.datetime().nullable().default(null),
  endsAt: z.iso.datetime().nullable().default(null),
  link: z.string().trim().max(60).nullable().default(null),
  sort: z.number().int().default(0),
  active: z.boolean().default(true),
});
const toRow = (b: Partial<z.infer<typeof CardBody>>) => ({
  ...b,
  startsAt: b.startsAt === undefined ? undefined : b.startsAt ? new Date(b.startsAt) : null,
  endsAt: b.endsAt === undefined ? undefined : b.endsAt ? new Date(b.endsAt) : null,
});
const checkRange = (b: { rule?: string; startsAt?: string | null; endsAt?: string | null }) => {
  if (b.rule === 'date_range' && (!b.startsAt || !b.endsAt)) throw badRequest('dates_required', 'A date-range card needs a start and an end date');
  if (b.startsAt && b.endsAt && b.endsAt < b.startsAt) throw badRequest('bad_dates', 'The end date is before the start date');
};

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, now } = app.deps;
  const owner = requireStaff('owner');

  app.get('/content', { preHandler: requireStaff('helpline') }, async () => ({
    cards: await db.select().from(homeCards).orderBy(asc(homeCards.sort), asc(homeCards.id)),
    pages: await db.select().from(contentPages),
  }));

  app.post('/content/cards', { preHandler: owner, schema: { body: CardBody } }, async (req) => {
    checkRange(req.body);
    const [c] = await db
      .insert(homeCards)
      .values({ ...toRow(req.body), updatedBy: req.staff.id, updatedAt: now() } as typeof homeCards.$inferInsert)
      .returning();
    await audit(db, staffActor(req), 'home_card_create', 'home_card', c.id, null, c);
    return c;
  });

  app.patch('/content/cards/:id', { preHandler: owner, schema: { params: z.object({ id: z.coerce.number().int() }), body: CardBody.partial() } }, async (req) => {
    const [before] = await db.select().from(homeCards).where(eq(homeCards.id, req.params.id));
    if (!before) throw notFound('Card');
    checkRange({ rule: req.body.rule ?? before.rule, startsAt: req.body.startsAt ?? before.startsAt?.toISOString() ?? null, endsAt: req.body.endsAt ?? before.endsAt?.toISOString() ?? null });
    const [after] = await db
      .update(homeCards)
      .set({ ...toRow(req.body), updatedBy: req.staff.id, updatedAt: now() })
      .where(eq(homeCards.id, before.id))
      .returning();
    await audit(db, staffActor(req), 'home_card_update', 'home_card', after.id, before, after);
    return after;
  });

  app.put('/content/pages/:key', { preHandler: owner, schema: { params: z.object({ key: z.enum(PAGE_KEYS) }), body: z.object({ body: Lang3(20_000) }) } }, async (req) => {
    const [before] = await db.select().from(contentPages).where(eq(contentPages.key, req.params.key));
    const [after] = await db
      .insert(contentPages)
      .values({ key: req.params.key, body: req.body.body, updatedBy: req.staff.id, updatedAt: now() })
      .onConflictDoUpdate({ target: contentPages.key, set: { body: req.body.body, updatedBy: req.staff.id, updatedAt: now() } })
      .returning();
    await audit(db, staffActor(req), 'content_page_update', 'content_page', req.params.key, before ?? null, after);
    return after;
  });
};

export default routes;
