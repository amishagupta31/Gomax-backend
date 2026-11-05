import { and, desc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { streakPhotos } from '../db/schema.js';
import { addDays, istDay, istWeek } from '../lib/time.js';

export type WeekDot = { date: string; status: 'done' | 'today' | 'missed' | 'future' };

/**
 * Photo streak (C2-13). A day counts once its photo is uploaded; a photo the
 * office rejects drops that day. Missing a day restarts the streak.
 */
export async function streakState(db: Db, userId: string, now: Date) {
  const rows = await db
    .select({ day: streakPhotos.day })
    .from(streakPhotos)
    .where(and(eq(streakPhotos.userId, userId), ne(streakPhotos.status, 'rejected')))
    .orderBy(desc(streakPhotos.day))
    .limit(400);
  const days = new Set(rows.map((r) => r.day));
  const today = istDay(now);
  const doneToday = days.has(today);

  let cursor = doneToday ? today : addDays(today, -1);
  let completed = 0;
  while (days.has(cursor)) {
    completed++;
    cursor = addDays(cursor, -1);
  }
  const runStart = addDays(cursor, 1);

  const weekStart = istDay(istWeek(now).start);
  const week: WeekDot[] = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart, i);
    const status: WeekDot['status'] = days.has(date) ? 'done' : date === today ? 'today' : date > today ? 'future' : 'missed';
    return { date, status };
  });

  /** "Day N" on C2-13: the day you are on (completed + 1 until today's photo is in). */
  const current = doneToday ? completed : completed + 1;
  return { completed, current, doneToday, runStart, week };
}
