import { and, asc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { contentPages, homeCards, type Lang3 } from '../db/schema.js';
import { requireUser } from '../plugins/auth.js';

// App side of D8a: live Home cards and the "How GoMax works" / T&C pages, in the
// applicator's language (English when a translation is missing). The app applies
// each card's rule (first 7 days, from 2nd visit) itself.
const pick = (t: Lang3, lang: string) => (lang === 'hi' ? t.hi : lang === 'pa' ? t.pa : undefined) || t.en;

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, now } = app.deps;

  app.get('/content', { preHandler: requireUser }, async (req) => {
    const t = now();
    const lang = req.currentUser.language;
    const cards = await db
      .select()
      .from(homeCards)
      .where(and(eq(homeCards.active, true), or(isNull(homeCards.startsAt), lte(homeCards.startsAt, t)), or(isNull(homeCards.endsAt), gt(homeCards.endsAt, t))))
      .orderBy(asc(homeCards.sort), asc(homeCards.id));
    const pages = await db.select().from(contentPages);
    return {
      cards: cards.map((c) => ({ id: c.id, title: pick(c.title, lang), body: pick(c.body, lang), art: c.art, rule: c.rule, link: c.link })),
      pages: Object.fromEntries(pages.map((p) => [p.key, pick(p.body, lang)])),
    };
  });
};

export default routes;
