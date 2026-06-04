/**
 * Display formatting helpers for the customer portal.
 *
 * Money formatting is owned by @marina/core (single source of truth, integer
 * cents) and re-exported here so pages have one import. Date/time helpers wrap
 * date-fns and accept either a Date or an ISO string (the shape the API returns).
 */
import { format, parseISO, isValid } from 'date-fns';

export { formatUSD } from '@marina/core';

/** Coerce an API value (Date | ISO string | number) into a valid Date or null. */
function toDate(value: Date | string | number): Date | null {
  if (value instanceof Date) return isValid(value) ? value : null;
  if (typeof value === 'number') {
    const d = new Date(value);
    return isValid(d) ? d : null;
  }
  const d = parseISO(value);
  return isValid(d) ? d : null;
}

/** "Jun 4, 2026" */
export function formatDate(value: Date | string | number): string {
  const d = toDate(value);
  return d ? format(d, 'MMM d, yyyy') : '';
}

/** "Thursday, June 4, 2026" — for headings and confirmations. */
export function formatLongDate(value: Date | string | number): string {
  const d = toDate(value);
  return d ? format(d, 'EEEE, MMMM d, yyyy') : '';
}

/** "9:30 AM" */
export function formatTime(value: Date | string | number): string {
  const d = toDate(value);
  return d ? format(d, 'h:mm a') : '';
}

/** "Jun 4, 2026 · 9:30 AM" */
export function formatDateTime(value: Date | string | number): string {
  const d = toDate(value);
  return d ? format(d, "MMM d, yyyy '·' h:mm a") : '';
}

/** YYYY-MM-DD — the canonical form for availability date params. */
export function formatISODate(value: Date | string | number): string {
  const d = toDate(value);
  return d ? format(d, 'yyyy-MM-dd') : '';
}

/** Human duration from minutes, e.g. 240 -> "4h", 90 -> "1h 30m", 45 -> "45m". */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}
