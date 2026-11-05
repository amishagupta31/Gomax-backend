// "Day" everywhere in GoMax = 12 am to 12 am India time (Asia/Kolkata, UTC+5:30, no DST).
const IST_MS = 330 * 60 * 1000;
const DAY_MS = 86_400_000;

const ist = (d: Date) => new Date(d.getTime() + IST_MS);

/** 'YYYY-MM-DD' of the IST calendar day containing `d`. */
export const istDay = (d: Date) => ist(d).toISOString().slice(0, 10);

/** 'YYYY-MM' of the IST month containing `d`. */
export const istMonth = (d: Date) => ist(d).toISOString().slice(0, 7);

/** UTC instant at which the IST day starts. */
export const istDayStart = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - IST_MS);

export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** IST week (Mon 12 am → next Mon 12 am) containing `d`. */
export function istWeek(d: Date) {
  const day = istDay(d);
  const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon = 0
  const start = addDays(day, -dow);
  return { key: `W${start}`, start: istDayStart(start), end: istDayStart(addDays(start, 7)) };
}

/** Seconds until the next IST midnight (spin reset countdown, C2-03). */
export const secondsToIstMidnight = (now: Date) => Math.max(0, Math.round((istDayStart(addDays(istDay(now), 1)).getTime() - now.getTime()) / 1000));

export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
