import type { Settings } from './settings.js';

export type RankInfo = Settings['ranks'][number];

/** Rank by lifetime points — never goes down when points are withdrawn. */
export function rankFor(lifetimePoints: number, ranks: Settings['ranks']) {
  const sorted = [...ranks].sort((a, b) => a.min - b.min);
  let current = sorted[0];
  for (const r of sorted) if (lifetimePoints >= r.min) current = r;
  const next = sorted[sorted.indexOf(current) + 1] ?? null;
  return { current, next, toNext: next ? next.min - lifetimePoints : 0 };
}

/** Rank benefit "+10% / +20% more runs" on challenge, quest and streak rewards. */
export const boostRuns = (runs: number, rank: RankInfo) => Math.round(runs * (1 + rank.runsBoostPct / 100));
