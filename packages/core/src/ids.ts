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

// Unambiguous alphabet for human-keyed codes — no 0/O/1/I/L to avoid misreads.
const GIFT_CARD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Build a human-facing, hard-to-mistype gift-card code in grouped form, e.g.
 * `ABCD-EFGH-JKMN`. Randomness comes from cuid2 (a CSPRNG); characters are mapped
 * into an unambiguous alphabet (no 0/O/1/I/L). Uniqueness is still enforced by the
 * DB's `@@unique([operator_id, code])`, so the issuing service should retry on the
 * rare collision rather than trust this to be globally unique.
 *
 * @param groups    number of dash-separated groups (default 3)
 * @param groupSize characters per group (default 4)
 */
export const generateGiftCardCode = (groups = 3, groupSize = 4): string => {
  const needed = Math.max(1, groups) * Math.max(1, groupSize);
  let pool = '';
  while (pool.length < needed) {
    pool += cuid2().toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  const chars: string[] = [];
  for (let i = 0; i < needed; i++) {
    const idx = pool.charCodeAt(i) % GIFT_CARD_ALPHABET.length;
    chars.push(GIFT_CARD_ALPHABET[idx]!);
  }
  const out: string[] = [];
  for (let g = 0; g < groups; g++) {
    out.push(chars.slice(g * groupSize, (g + 1) * groupSize).join(''));
  }
  return out.join('-');
};
