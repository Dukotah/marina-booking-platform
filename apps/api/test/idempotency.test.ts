/**
 * Idempotent booking create — pure unit tests for the replay decision. No DB, no
 * network; these pin the logic that decides whether a failed insert is a duplicate
 * submit to be resolved against the winner, or a real error to surface.
 *
 * Why this matters (LOCAL-FIRST-BUILD §5, "a double-submit or a flaky connection
 * cannot double-charge"): the durable guard is the unique index
 * `Order(operator_id, idempotency_key)`. Both submits insert, one loses, and the
 * loser's whole transaction rolls back. Everything below is the decision the loser
 * makes about the error it just caught — get it wrong in either direction and you
 * either return a 500 on a harmless retry, or swallow a genuine constraint bug.
 */
import { describe, it, expect } from 'vitest';
import {
  BookingError,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  isIdempotencyViolation,
  isUniqueViolation,
  normalizeIdempotencyKey,
  shouldResolveAsReplay,
  uniqueViolationTargets,
} from '../src/services/booking.js';

/**
 * A stand-in for `PrismaClientKnownRequestError`. Built by hand on purpose: the
 * production code duck-types on `code` precisely so it keeps working when the error
 * arrives from a second copy of the generated client, and a hand-built object is
 * the only way to test that it does.
 */
function prismaError(code: string, target?: unknown): Error & { code: string; meta?: unknown } {
  const err = new Error(`Prisma ${code}`) as Error & { code: string; meta?: unknown };
  err.name = 'PrismaClientKnownRequestError';
  err.code = code;
  if (target !== undefined) err.meta = { target };
  return err;
}

/** The shape Postgres + Prisma actually produce for our Order index. */
const orderKeyConflict = () => prismaError('P2002', ['operator_id', 'idempotency_key']);

describe('normalizeIdempotencyKey', () => {
  it('keeps a well-formed key verbatim', () => {
    expect(normalizeIdempotencyKey('e2e-1756000000000-a1b2c3')).toBe('e2e-1756000000000-a1b2c3');
  });

  it('trims surrounding whitespace so " k " and "k" are the same submit', () => {
    expect(normalizeIdempotencyKey('  abc123  ')).toBe('abc123');
  });

  it('treats an absent key as null', () => {
    expect(normalizeIdempotencyKey(undefined)).toBeNull();
    expect(normalizeIdempotencyKey(null)).toBeNull();
  });

  it('maps blank and whitespace-only keys to null, never to the empty string', () => {
    // '' is a real value to the unique index: if two keyless orders both stored ''
    // the second would collide with the first and be served the WRONG order. NULL
    // is the only value Postgres lets repeat in a unique index.
    expect(normalizeIdempotencyKey('')).toBeNull();
    expect(normalizeIdempotencyKey('   ')).toBeNull();
    expect(normalizeIdempotencyKey('\t\n')).toBeNull();
  });

  it('ignores non-string input rather than coercing it', () => {
    // A coerced key would let `{"idempotencyKey": 0}` and `{"idempotencyKey": "0"}`
    // resolve to each other's orders.
    expect(normalizeIdempotencyKey(42)).toBeNull();
    expect(normalizeIdempotencyKey({ key: 'x' })).toBeNull();
    expect(normalizeIdempotencyKey(['x'])).toBeNull();
    expect(normalizeIdempotencyKey(true)).toBeNull();
  });

  it('accepts a key exactly at the length limit', () => {
    const key = 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH);
    expect(normalizeIdempotencyKey(key)).toBe(key);
  });

  it('rejects an over-length key instead of truncating it', () => {
    // Truncation is the dangerous option: two distinct submits sharing a long
    // prefix would collapse into one order.
    const key = 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1);
    expect(() => normalizeIdempotencyKey(key)).toThrow(BookingError);
    try {
      normalizeIdempotencyKey(key);
    } catch (err) {
      expect((err as BookingError).code).toBe('INVALID_IDEMPOTENCY_KEY');
      expect((err as BookingError).status).toBe(400);
    }
  });

  it('measures the limit after trimming', () => {
    const key = `  ${'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH)}  `;
    expect(normalizeIdempotencyKey(key)).toHaveLength(MAX_IDEMPOTENCY_KEY_LENGTH);
  });
});

describe('isUniqueViolation', () => {
  it('recognises P2002 without relying on instanceof', () => {
    expect(isUniqueViolation(orderKeyConflict())).toBe(true);
  });

  it('rejects every other Prisma error code', () => {
    expect(isUniqueViolation(prismaError('P2003'))).toBe(false); // FK violation
    expect(isUniqueViolation(prismaError('P2025'))).toBe(false); // record not found
    expect(isUniqueViolation(prismaError('P2028'))).toBe(false); // tx timeout
  });

  it('rejects plain errors and non-errors', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(new BookingError('INSUFFICIENT_CAPACITY', 'full', 409))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('P2002')).toBe(false);
  });
});

describe('uniqueViolationTargets', () => {
  it('reads the field-name array Postgres reports', () => {
    expect(uniqueViolationTargets(orderKeyConflict())).toEqual(['operator_id', 'idempotency_key']);
  });

  it('reads a bare constraint-name string', () => {
    // Some driver/version combinations report the index name instead of columns.
    expect(uniqueViolationTargets(prismaError('P2002', 'Order_operator_id_idempotency_key_key'))).toEqual(
      ['Order_operator_id_idempotency_key_key'],
    );
  });

  it('is empty when meta is missing entirely', () => {
    expect(uniqueViolationTargets(prismaError('P2002'))).toEqual([]);
  });

  it('is empty for errors that are not unique violations', () => {
    expect(uniqueViolationTargets(prismaError('P2003', ['order_id']))).toEqual([]);
    expect(uniqueViolationTargets(new Error('boom'))).toEqual([]);
  });

  it('drops non-string entries rather than leaking them downstream', () => {
    expect(uniqueViolationTargets(prismaError('P2002', ['operator_id', 7, null]))).toEqual([
      'operator_id',
    ]);
  });
});

describe('isIdempotencyViolation', () => {
  it('is true for the column-array form', () => {
    expect(isIdempotencyViolation(orderKeyConflict())).toBe(true);
  });

  it('is true for the constraint-name form', () => {
    expect(
      isIdempotencyViolation(prismaError('P2002', 'Order_operator_id_idempotency_key_key')),
    ).toBe(true);
  });

  it('is false for a collision on a different index', () => {
    // The per-day order_number sequence is the realistic other collision: two
    // simultaneous submits can count the same seq.
    expect(isIdempotencyViolation(prismaError('P2002', ['order_number']))).toBe(false);
  });

  it('is false when the target is unknown', () => {
    expect(isIdempotencyViolation(prismaError('P2002'))).toBe(false);
  });
});

describe('shouldResolveAsReplay', () => {
  const key = 'checkout-abc';

  it('resolves a keyed unique violation by looking the winner up', () => {
    expect(shouldResolveAsReplay(orderKeyConflict(), key)).toBe(true);
  });

  it('still looks up when Prisma reported no target', () => {
    // meta.target is not always populated. A lookup that finds nothing rethrows,
    // so an unnecessary one costs a read; a skipped one costs a spurious 500 on a
    // legitimate retry.
    expect(shouldResolveAsReplay(prismaError('P2002'), key)).toBe(true);
  });

  it('still looks up when the collision is reported against another index', () => {
    // Any unique violation on a keyed create means a concurrent writer got there
    // first; the lookup is what actually decides.
    expect(shouldResolveAsReplay(prismaError('P2002', ['order_number']), key)).toBe(true);
  });

  it('never treats a keyless create as a replay', () => {
    // With no key there is nothing to look the order up BY, so a duplicate-key
    // error here is a genuine bug and must surface.
    expect(shouldResolveAsReplay(orderKeyConflict(), null)).toBe(false);
    expect(shouldResolveAsReplay(prismaError('P2002'), null)).toBe(false);
  });

  it('never swallows a non-unique failure, key or not', () => {
    // A sold-out slot, a bad promo, or a transaction timeout must reach the caller
    // unchanged — returning "your other order" for those would be a lie.
    expect(shouldResolveAsReplay(new BookingError('INSUFFICIENT_CAPACITY', 'full', 409), key)).toBe(
      false,
    );
    expect(shouldResolveAsReplay(prismaError('P2003', ['order_id']), key)).toBe(false);
    expect(shouldResolveAsReplay(prismaError('P2028'), key)).toBe(false);
    expect(shouldResolveAsReplay(new Error('connection reset'), key)).toBe(false);
  });

  it('composes with normalizeIdempotencyKey: a blank key is a keyless create', () => {
    // The end-to-end path a route follows — normalize, then decide.
    expect(shouldResolveAsReplay(orderKeyConflict(), normalizeIdempotencyKey('   '))).toBe(false);
    expect(shouldResolveAsReplay(orderKeyConflict(), normalizeIdempotencyKey(' k '))).toBe(true);
  });
});
