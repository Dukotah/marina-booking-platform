/**
 * Identifier generation. Application-generated ids use cuid2 (collision-resistant,
 * URL-safe, sortable-by-creation-monotonic enough for our needs). Order numbers are
 * human-facing and follow a per-location, per-day sequential format.
 */
import { createId as cuid2 } from '@paralleldrive/cuid2';

/** Generate a collision-resistant, URL-safe unique id. */
export const createId = (): string => cuid2();

/**
 * Build a human-facing order number from a location code, a date, and a per-day
 * sequence number.
 *
 * Format: `<UPPERCASE_CODE><YYMMDD><SEQ3>` — e.g. ("LSRA", 2026-06-04, 1) =>
 * "LSRA260604001". The date is rendered in local time. The sequence is
 * zero-padded to three digits; sequences past 999 render with their natural
 * width (e.g. 1000 -> "1000") so numbers never collide.
 *
 * @param locationCode short alphanumeric code for the location (case-insensitive)
 * @param date         the order date (calendar day is what matters)
 * @param seq          1-based sequence number for that location + day
 */
export const generateOrderNumber = (locationCode: string, date: Date, seq: number): string => {
  const code = locationCode.trim().toUpperCase();
  const yy = String(date.getFullYear() % 100).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const seqStr = String(Math.max(0, Math.trunc(seq))).padStart(3, '0');
  return `${code}${yy}${mm}${dd}${seqStr}`;
};
