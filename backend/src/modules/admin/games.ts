import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { challenges, streakPhotos, users } from '../../db/schema.js';
import { conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { notify, queueWhatsApp } from '../../lib/notify.js';
import { requireStaff, staffActor } from '../../plugins/auth.js';
import { clearCatalogCache } from '../../services/challenges.js';
import { page, PageQuery, timeCursor, timeKey } from '../../lib/page.js';

// D7 Games & challenges (odds/prizes live in Settings → spinOdds / scratch).
const ChallengeBody = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  kind: z.enum(['scan_count', 'ultra_scan_count', 'invite_count', 'streak_days']),
  period: z.enum(['week', 'range']),
  tag: z.string().trim().min(2).max(30),
  tone: z.enum(['runs', 'primary', 'warning', 'success', 'danger']).default('runs'),
  title: z.string().trim().min(3).max(80),
  shortTitle: z.string().trim().min(3).max(40),
  goal: z.number().int().positive(),
  rewardRuns: z.number().int().min(0),
  rewardScratchCards: z.number().int().min(0).max(5).default(0),
  bonusText: z.string().max(80).nullable().default(null),
  art: z.string().max(40).default('bullseye'),
  milestones: z.array(z.object({ at: z.number().int().positive(), title: z.string().max(60), sub: z.string().max(60).optional(), scratchCards: z.number().int().min(0).max(3).optional() })).max(6).default([]),
  startsAt: z.iso.datetime().nullable().default(null),
  endsAt: z.iso.datetime().nullable().default(null),
  active: z.boolean().default(true),
  sort: z.number().int().default(0),
});
const toRow = (b: Partial<z.infer<typeof ChallengeBody>>) => ({
  ...b,
  startsAt: b.startsAt === undefined ? undefined : b.startsAt ? new Date(b.startsAt) : null,
  endsAt: b.endsAt === undefined ? undefined : b.endsAt ? new Date(b.endsAt) : null,
});

const routes: FastifyPluginAsyncZod = async (app) => {
  const { db, store, now } = app.deps;

  app.get('/challenges', { preHandler: requireStaff('ops', 'helpline') }, async () => ({
    challenges: await db.select().from(challenges).orderBy(asc(challenges.sort)),
  }));

  app.post('/challenges', { preHandler: requireStaff('owner'), schema: { body: ChallengeBody } }, async (req) => {
    const [c] = await db.insert(challenges).values(toRow(req.body) as typeof challenges.$inferInsert).onConflictDoNothing().returning();
    if (!c) throw conflict('exists', 'A challenge with this id already exists');
    clearCatalogCache(db);
    await audit(db, staffActor(req), 'challenge_create', 'challenge', c.id, null, c);
    return c;
  });

  app.patch('/challenges/:id', { preHandler: requireStaff('owner'), schema: { params: z.object({ id: z.string() }), body: ChallengeBody.omit({ id: true }).partial() } }, async (req) => {
    const [before] = await db.select().from(challenges).where(eq(challenges.id, req.params.id));
    if (!before) throw notFound('Challenge');
    const [after] = await db.update(challenges).set(toRow(req.body)).where(eq(challenges.id, before.id)).returning();
    clearCatalogCache(db);
    await audit(db, staffActor(req), 'challenge_update', 'challenge', before.id, before, after);
    return after;
  });

  // D7e / M2: streak photo review queue (office staff).
  app.get('/streak-photos', { preHandler: requireStaff('ops'), schema: { querystring: z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending'), ...PageQuery }) } }, async (req) => {
    const pending = req.query.status === 'pending';
    const rows = await db
      .select({ p: streakPhotos, name: users.name, mobile: users.mobile })
      .from(streakPhotos)
      .innerJoin(users, eq(users.id, streakPhotos.userId))
      .where(and(eq(streakPhotos.status, req.query.status), pending ? undefined : timeCursor(streakPhotos.createdAt, streakPhotos.id, req.query.cursor)))
      .orderBy(pending ? asc(streakPhotos.createdAt) : desc(streakPhotos.createdAt), pending ? asc(streakPhotos.id) : desc(streakPhotos.id))
      .limit(pending ? 200 : req.query.limit + 1);
    const p = pending ? { rows, nextCursor: null } : page(rows, req.query.limit, (r) => timeKey(r.p.createdAt, r.p.id));
    return {
      nextCursor: p.nextCursor,
      rows: await Promise.all(
        p.rows.map(async (r) => ({ id: r.p.id, day: r.p.day, takenAt: r.p.takenAt.toISOString(), lat: r.p.lat, lng: r.p.lng, status: r.p.status, reason: r.p.reason, name: r.name, mobile: r.mobile, url: await store.signedGet(r.p.object) })),
      ),
    };
  });

  app.post(
    '/streak-photos/:id/review',
    { preHandler: requireStaff('ops'), schema: { params: z.object({ id: z.uuid() }), body: z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().max(120).optional() }) } },
    async (req) => {
      const { decision, reason } = req.body;
      const [p] = await db
        .update(streakPhotos)
        .set({ status: decision, reason: decision === 'rejected' ? (reason ?? 'Not a work photo') : null, reviewedBy: req.staff.id, reviewedAt: now() })
        .where(eq(streakPhotos.id, req.params.id))
        .returning();
      if (!p) throw notFound('Photo');
      if (decision === 'rejected') {
        // Rejected = that day doesn't count; the streak recalculates from the photos left.
        await notify(db, p.userId, { kind: 'games', title: 'Work photo not accepted', body: p.reason ?? undefined, art: 'cross-mark', link: { route: 'PhotoStreak' } });
        await queueWhatsApp(db, p.userId, 'streak_photo_rejected', { reason: p.reason ?? '' });
      }
      await audit(db, staffActor(req), `streak_${decision}`, 'streak_photo', p.id, null, { reason });
      return { ok: true };
    },
  );
};

export default routes;
