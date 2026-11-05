import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { notifications } from '../db/schema.js';
import { requireUser } from '../plugins/auth.js';
import { idCursor, page, PageQuery } from '../lib/page.js';

// C4-02 Notifications. Filters: All · Money · Gifts · Games · Invite.
const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, now } = app.deps;
  app.addHook('preHandler', requireUser);

  app.get(
    '/notifications',
    { schema: { querystring: z.object({ kind: z.enum(['all', 'money', 'gifts', 'games', 'invite']).default('all'), ...PageQuery }) } },
    async (req) => {
      const rows = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, req.userId),
            req.query.kind === 'all' ? undefined : eq(notifications.kind, req.query.kind),
            idCursor(notifications.id, req.query.cursor),
          ),
        )
        .orderBy(desc(notifications.id))
        .limit(req.query.limit + 1);
      const p = page(rows, req.query.limit, (r) => String(r.id));
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.userId, req.userId), isNull(notifications.readAt)));
      return {
        unread: n,
        nextCursor: p.nextCursor,
        rows: p.rows.map((r) => ({
          id: String(r.id),
          kind: r.kind,
          title: r.title,
          body: r.body,
          art: r.art,
          link: r.link,
          read: Boolean(r.readAt),
          at: r.createdAt.toISOString(),
        })),
      };
    },
  );

  app.post(
    '/notifications/read',
    { schema: { body: z.union([z.object({ ids: z.array(z.string().regex(/^\d+$/)).min(1).max(200) }), z.object({ all: z.literal(true) })]) } },
    async (req) => {
      const mine = and(eq(notifications.userId, req.userId), isNull(notifications.readAt));
      await db
        .update(notifications)
        .set({ readAt: now() })
        .where('ids' in req.body ? and(mine, inArray(notifications.id, req.body.ids.map(Number))) : mine);
      return { ok: true };
    },
  );
};

export default routes;
