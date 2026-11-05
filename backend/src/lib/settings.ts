import { z } from 'zod';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';

// Every limit, odd and reward lives here (D9 "all limits in one place").
// Defaults follow the Figma dev notes; owners change them in Admin → Settings.
const Rank = z.object({
  id: z.string(),
  name: z.string(),
  min: z.number().int().min(0),
  spins: z.number().int().min(0).max(10),
  runsBoostPct: z.number().int().min(0).max(100),
});

export const SettingsSchema = z.object({
  withdraw: z.object({
    minPoints: z.number().int().positive(),
    maxPerRequest: z.number().int().positive(),
    maxPerMonth: z.number().int().positive(),
  }),
  firstCouponBonus: z.number().int().min(0),
  ranks: z.array(Rank).min(1),
  /** Spin prizes and weights. 100 runs can never be drawn (D7) — rejected here and in spin(). */
  spinOdds: z
    .array(z.object({ runs: z.number().int().positive(), weight: z.number().min(0) }))
    .min(1)
    .refine((a) => a.every((o) => o.runs !== 100), '100 runs must stay at 0% odds'),
  scratch: z.object({
    couponsPerCard: z.number().int().positive(),
    expiryDays: z.number().int().positive(),
    prizes: z.array(z.object({ kind: z.enum(['runs', 'points']), amount: z.number().int().positive(), weight: z.number().min(0) })).min(1),
  }),
  referral: z.object({
    firstCouponBonusRuns: z.number().int().min(0),
    levelSharePct: z.number().min(0).max(100),
    levels: z.number().int().min(0).max(4),
    monthlyCapRuns: z.number().int().min(0),
  }),
  streak: z.object({ rewards: z.array(z.object({ days: z.number().int().positive(), runs: z.number().int().min(0) })) }),
  quests: z.object({ scan: z.number().int().min(0), invite: z.number().int().min(0), photo: z.number().int().min(0) }),
  fraud: z.object({
    burstScans: z.number().int().positive(),
    burstMinutes: z.number().int().positive(),
    jumpKm: z.number().positive(),
    jumpMinutes: z.number().int().positive(),
  }),
  payout: z.object({ lockMinutes: z.number().int().positive() }),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  withdraw: { minPoints: 500, maxPerRequest: 5000, maxPerMonth: 15000 },
  firstCouponBonus: 25,
  ranks: [
    { id: 'naya-saathi', name: 'Naya Saathi', min: 0, spins: 3, runsBoostPct: 0 },
    { id: 'kaarigar', name: 'Kaarigar', min: 500, spins: 4, runsBoostPct: 10 },
    { id: 'ustaad', name: 'Ustaad', min: 2000, spins: 5, runsBoostPct: 20 },
    { id: 'legend', name: 'GoMax Legend', min: 5000, spins: 5, runsBoostPct: 20 }, // CLIENT to confirm
  ],
  spinOdds: [
    { runs: 5, weight: 55 },
    { runs: 10, weight: 45 },
  ],
  scratch: {
    couponsPerCard: 10,
    expiryDays: 7,
    prizes: [
      { kind: 'runs', amount: 10, weight: 30 },
      { kind: 'runs', amount: 20, weight: 40 },
      { kind: 'runs', amount: 30, weight: 20 },
      { kind: 'points', amount: 10, weight: 10 },
    ],
  },
  referral: { firstCouponBonusRuns: 50, levelSharePct: 10, levels: 4, monthlyCapRuns: 200 },
  streak: {
    rewards: [
      { days: 15, runs: 50 },
      { days: 30, runs: 120 },
      { days: 45, runs: 200 },
      { days: 90, runs: 500 },
      { days: 120, runs: 800 },
    ],
  },
  quests: { scan: 10, invite: 50, photo: 5 },
  fraud: { burstScans: 15, burstMinutes: 5, jumpKm: 50, jumpMinutes: 30 },
  payout: { lockMinutes: 15 },
};

// Settings are read on almost every request but change rarely: keep them
// 30 s per instance. The instance that saves a change clears its copy at once;
// other instances pick it up within 30 s.
const CACHE_MS = 30_000;
const cache = new WeakMap<object, { at: number; value: Settings }>();

export function clearSettingsCache(db: Db) {
  cache.delete(db);
}

/** Saved values over defaults. */
export async function getSettings(db: Db): Promise<Settings> {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const rows = await db.select().from(settings);
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value;
  cache.set(db, { at: Date.now(), value: out as Settings });
  return out as Settings;
}

export function pickWeighted<T extends { weight: number }>(items: T[], rnd = Math.random()): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let x = rnd * total;
  for (const i of items) {
    if ((x -= i.weight) < 0) return i;
  }
  return items[items.length - 1];
}
