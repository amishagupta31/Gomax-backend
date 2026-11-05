import { and, desc, eq, gt, gte, isNotNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { fraudFlags, scans, users } from '../db/schema.js';
import type { Settings } from '../lib/settings.js';

// D1/D3/M1 fraud rules. A flag puts the applicator's cash on hold (no
// withdrawals) until an owner clears it in Admin → Flags.

export async function raiseFlag(db: Db, userId: string, rule: string, details: Record<string, unknown>, now: Date) {
  // One open flag per rule per day is enough for the owner to act on.
  const [open] = await db
    .select({ id: fraudFlags.id })
    .from(fraudFlags)
    .where(and(eq(fraudFlags.userId, userId), eq(fraudFlags.rule, rule), eq(fraudFlags.status, 'open'), gt(fraudFlags.createdAt, new Date(now.getTime() - 86_400_000))));
  if (open) return;
  await db.insert(fraudFlags).values({ userId, rule, details });
  await db.update(users).set({ cashHold: true }).where(eq(users.id, userId));
}

/** "2 accounts on 1 phone". */
export async function checkSharedDevice(db: Db, userId: string, deviceId: string) {
  const others = await db
    .select({ id: users.id, mobile: users.mobile })
    .from(users)
    .where(and(eq(users.lastDeviceId, deviceId), ne(users.id, userId)))
    .limit(5);
  if (others.length) await raiseFlag(db, userId, 'shared_device', { deviceId, otherAccounts: others.map((o) => o.mobile) }, new Date());
}

export function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Burst (>N scans in M min) and GPS jump (>X km in Y min), checked after each added scan. */
export async function checkScanFraud(db: Db, s: Settings['fraud'], userId: string, at: Date, gps: { lat: number; lng: number } | null, now: Date) {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scans)
    .where(and(eq(scans.userId, userId), eq(scans.result, 'added'), gte(scans.scannedAt, new Date(at.getTime() - s.burstMinutes * 60_000))));
  if (n > s.burstScans) await raiseFlag(db, userId, 'scan_burst', { scans: n, minutes: s.burstMinutes }, now);

  if (gps) {
    const [prev] = await db
      .select({ lat: scans.lat, lng: scans.lng, at: scans.scannedAt })
      .from(scans)
      .where(
        and(
          eq(scans.userId, userId),
          eq(scans.result, 'added'),
          isNotNull(scans.lat),
          gte(scans.scannedAt, new Date(at.getTime() - s.jumpMinutes * 60_000)),
          ne(scans.scannedAt, at),
        ),
      )
      .orderBy(desc(scans.scannedAt))
      .limit(1);
    if (prev?.lat != null && prev.lng != null) {
      const d = km({ lat: prev.lat, lng: prev.lng }, gps);
      if (d > s.jumpKm) await raiseFlag(db, userId, 'gps_jump', { km: Math.round(d), minutes: s.jumpMinutes }, now);
    }
  }
}

/** Many wrong-code tries from one account → flag (D3). */
export async function checkWrongCodes(db: Db, userId: string, now: Date) {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scans)
    .where(and(eq(scans.userId, userId), eq(scans.result, 'wrong_code'), gte(scans.receivedAt, new Date(now.getTime() - 10 * 60_000))));
  if (n >= 10) await raiseFlag(db, userId, 'wrong_codes', { tries: n, minutes: 10 }, now);
}
