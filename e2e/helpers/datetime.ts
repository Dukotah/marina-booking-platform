/**
 * Date/time formatting that mirrors what the customer site renders.
 *
 * The apps format with date-fns in the BROWSER's local timezone. The suite pins the
 * browser to `TIMEZONE` (see e2e/config.ts), so every helper here formats in that same
 * zone via Intl — no date-fns dependency, and no chance of the fixture computing
 * "March 7" while the browser paints "March 6".
 */
import { TIMEZONE } from '../config';

/** `2026-03-07` for an instant, in the operator's timezone. */
export function isoDate(value: Date | string): string {
  const parts = partsOf(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** `Saturday, March 7` — the prefix of an availability day button's accessible name. */
export function dayLabel(value: Date | string): string {
  const d = toDate(value);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'long' }).format(d);
  const monthDay = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    month: 'long',
    day: 'numeric',
  }).format(d);
  return `${weekday}, ${monthDay}`;
}

/** `9:30 AM` — matches `formatTime` in apps/web/lib/format.ts. */
export function timeLabel(value: Date | string): string {
  const d = toDate(value);
  // Intl uses U+202F (narrow no-break space) before the meridiem in recent ICU;
  // date-fns writes a plain space. Normalise so a selector built here matches the DOM.
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(d)
    .replace(/ | /g, ' ');
}

/** `Saturday, March 7, 2026` — matches `formatLongDate`. */
export function longDateLabel(value: Date | string): string {
  const d = toDate(value);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

/** Whole hours from now until `value`. Negative for the past. */
export function hoursFromNow(value: Date | string): number {
  return (toDate(value).getTime() - Date.now()) / 3_600_000;
}

/** `date` shifted by whole days, evaluated as a calendar day in the operator's zone. */
export function addDays(value: Date | string, days: number): Date {
  const d = toDate(value);
  return new Date(d.getTime() + days * 86_400_000);
}

/** Today's calendar date in the operator's timezone, as `YYYY-MM-DD`. */
export function today(): string {
  return isoDate(new Date());
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function partsOf(value: Date | string): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(toDate(value));
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { year: pick('year'), month: pick('month'), day: pick('day') };
}
