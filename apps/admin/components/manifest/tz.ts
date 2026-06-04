/**
 * Timezone helpers for the manifest + calendar.
 *
 * Timeslots are stored in UTC; the operator's timezone is the lens we render
 * through (see schema header). We avoid pulling in a tz library and instead use the
 * built-in `Intl.DateTimeFormat` to project a UTC instant into an operator-local
 * wall-clock breakdown, and to compute the UTC bounds of a local calendar day.
 *
 * All functions take an IANA timezone string (e.g. "America/Los_Angeles").
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
}

/** Break a UTC instant into operator-local calendar parts. */
export function toLocalParts(instant: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  // Intl can emit "24" for midnight under hour12:false; normalize to 0.
  let hour = parseInt(map.hour ?? '0', 10);
  if (hour === 24) hour = 0;
  return {
    year: parseInt(map.year ?? '0', 10),
    month: parseInt(map.month ?? '1', 10),
    day: parseInt(map.day ?? '1', 10),
    hour,
    minute: parseInt(map.minute ?? '0', 10),
  };
}

/** Minutes since local midnight for a UTC instant in the operator timezone. */
export function localMinutesOfDay(instant: Date, timeZone: string): number {
  const p = toLocalParts(instant, timeZone);
  return p.hour * 60 + p.minute;
}

/**
 * The UTC offset (in minutes, where local = utc + offset) for a timezone at a given
 * instant. Derived by comparing the formatted local parts back to a UTC timestamp.
 */
function offsetMinutes(instant: Date, timeZone: string): number {
  const p = toLocalParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/**
 * Compute the [start, end) UTC instants that bound a local calendar day. The day is
 * given as YYYY-MM-DD interpreted in the operator timezone. Handles DST by resolving
 * the offset at the candidate local-midnight instant.
 */
export function localDayRangeUtc(
  isoDate: string,
  timeZone: string,
): { startUtc: Date; endUtc: Date } {
  const [y, m, d] = isoDate.split('-').map((n) => parseInt(n, 10));
  // First approximation: treat the wall-clock midnight as if it were UTC, then
  // correct by the timezone offset measured at that instant.
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset = offsetMinutes(new Date(guess), timeZone);
  const startUtc = new Date(guess - offset * 60000);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

/** UTC bounds covering a full local week (7 days) starting at `isoDate`. */
export function localWeekRangeUtc(
  isoStartDate: string,
  timeZone: string,
): { startUtc: Date; endUtc: Date } {
  const { startUtc } = localDayRangeUtc(isoStartDate, timeZone);
  const endUtc = new Date(startUtc.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

/** Today's date as YYYY-MM-DD in the operator timezone. */
export function todayIsoIn(timeZone: string): string {
  const p = toLocalParts(new Date(), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Validate a YYYY-MM-DD string; falls back to today (operator tz) when invalid. */
export function normalizeIsoDate(value: string | undefined, timeZone: string): string {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map((n) => parseInt(n, 10));
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return value;
  }
  return todayIsoIn(timeZone);
}

/** Add whole days to a YYYY-MM-DD string (calendar arithmetic, tz-agnostic). */
export function addIsoDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((n) => parseInt(n, 10));
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(
    base.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** The Monday-based week start (YYYY-MM-DD) containing `isoDate`. */
export function weekStartIso(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat
  const deltaToMonday = (dow + 6) % 7; // days since Monday
  return addIsoDays(isoDate, -deltaToMonday);
}
