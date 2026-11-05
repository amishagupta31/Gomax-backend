import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { notifications, users, waOutbox, type NoteLink } from '../db/schema.js';

/**
 * WhatsApp utility templates (C4-03 … C4-14 + D4/D5 status messages).
 * Names must match the templates approved in Meta Business Manager.
 */
export const WA_TEMPLATES = [
  'welcome', 'daily_summary', 'scratch_card', 'withdrawal_approved', 'withdrawal_paid', 'withdrawal_rejected',
  'withdrawal_failed', 'gift_packed', 'gift_shipped', 'gift_delivered', 'rank_up', 'challenge_won', 'kyc_reminder',
  'password_reset', 'friend_joined', 'streak_missed', 'streak_photo_rejected',
] as const;
export type WaTemplate = (typeof WA_TEMPLATES)[number];

export type Note = {
  kind: 'money' | 'gifts' | 'games' | 'invite';
  title: string;
  body?: string;
  art?: string;
  link?: NoteLink;
};

/** In-app notification (C4-02). */
export async function notify(db: Db, userId: string, n: Note) {
  await db.insert(notifications).values({ userId, ...n });
}

/** Queue a WhatsApp template; the outbox job sends it (retries, backoff). */
export async function queueWhatsApp(
  db: Db,
  userId: string,
  template: WaTemplate,
  vars: Record<string, string>,
  opts: { force?: boolean; sendAfter?: Date } = {},
) {
  const [u] = await db
    .select({ mobile: users.mobile, optIn: users.whatsappOptIn, name: users.name, lang: users.language })
    .from(users)
    .where(eq(users.id, userId));
  if (!u || (!u.optIn && !opts.force)) return;
  await db.insert(waOutbox).values({
    userId,
    toMobile: u.mobile,
    template,
    vars: { name: u.name.split(' ')[0], lang: u.lang, ...vars },
    sendAfter: opts.sendAfter ?? new Date(0), // due now
  });
}
