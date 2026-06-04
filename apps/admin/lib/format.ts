import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns';
import { formatUSD, fromCents, toCents } from '@marina/core';

/**
 * Admin formatting helpers. Money formatting is re-exported from @marina/core so
 * the whole platform shares one implementation (all amounts are integer cents).
 * Date helpers wrap date-fns with the conventions the admin UI uses.
 */

export { formatUSD, fromCents, toCents };

/** "Jun 4, 2026" */
export function formatDate(value: Date | string | number): string {
  return format(toDate(value), 'MMM d, yyyy');
}

/** "3:45 PM" */
export function formatTime(value: Date | string | number): string {
  return format(toDate(value), 'h:mm a');
}

/** "Jun 4, 2026 · 3:45 PM" */
export function formatDateTime(value: Date | string | number): string {
  return format(toDate(value), "MMM d, yyyy '·' h:mm a");
}

/** Short weekday + date for manifest/calendar headers: "Thu, Jun 4" */
export function formatShortDate(value: Date | string | number): string {
  return format(toDate(value), 'EEE, MMM d');
}

/** ISO date string (YYYY-MM-DD) for query params and date inputs. */
export function toDateInputValue(value: Date | string | number): string {
  return format(toDate(value), 'yyyy-MM-dd');
}

/**
 * Friendly relative time used in tables/feeds:
 *  - today  -> "3:45 PM"
 *  - yesterday -> "Yesterday"
 *  - else   -> "5 days ago"
 */
export function formatRelative(value: Date | string | number): string {
  const date = toDate(value);
  if (isToday(date)) return formatTime(date);
  if (isYesterday(date)) return 'Yesterday';
  return formatDistanceToNow(date, { addSuffix: true });
}

/** "2,408" — locale-grouped integer/number. */
export function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

/** "42%" from a 0–1 ratio (rounded). */
export function formatPercent(ratio: number, fractionDigits = 0): string {
  return `${(ratio * 100).toFixed(fractionDigits)}%`;
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}
