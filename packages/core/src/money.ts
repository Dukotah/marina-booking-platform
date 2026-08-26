/**
 * Money primitives. The entire platform stores money as INTEGER CENTS — this
 * module is the single place that arithmetic is allowed to produce a fraction,
 * and the single place it is allowed to round.
 *
 * Three rules it exists to enforce:
 *
 *   1. **Rounding is explicit.** `Math.round` is half-up, which is asymmetric
 *      across zero (`-1.5 -> -1`). That is fine for a price and wrong for a
 *      refund, so every helper takes a `RoundingMode` and the default is stated.
 *   2. **Percentages are exact.** `cents * pct / 100` in binary floats is not:
 *      `1.005 * 100` is `100.49999999999999`, so an 0.5% fee on a $2.01 charge
 *      can land a cent low. Percentages are converted to an integer
 *      numerator/denominator and divided with exact integer remainder maths, so
 *      a half-cent is a *real* half-cent before a rounding mode decides it.
 *   3. **Splitting cannot lose or invent a penny.** `allocate` distributes a
 *      total across weights by largest remainder: every part is within one cent
 *      of its ideal share and the parts always sum back to exactly the total.
 *      This is the bug that silently corrupts ledgers — a $10.00 order split
 *      three ways as `round(1000/3)` is $10.01.
 *
 * Everything here is pure and DB-free. `toCents` / `fromCents` / `formatUSD`
 * are re-exported from `@marina/types` so there is one implementation platform-
 * wide.
 */
import { formatUSD, fromCents, toCents } from '@marina/types';

export { toCents, fromCents, formatUSD };

/** A money invariant was violated: a non-integer amount, an overflow, an unbalanced total. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** True when `value` is a safe integer — i.e. a legal cent amount. Negatives are legal (refunds, adjustments). */
export function isCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Assert a value is a legal integer-cent amount and return it. Use at the edges
 * (route input, processor response, CSV import) so a float never reaches the
 * ledger: `NaN` and `12.5` cents are bugs, and failing here beats failing three
 * tables later.
 */
export function assertCents(value: unknown, label = 'amount'): number {
  if (!isCents(value)) {
    throw new MoneyError(`${label} must be an integer number of cents, got ${String(value)}`);
  }
  return value;
}

/**
 * Sum integer cents, validating every term. Plain `reduce` happily sums floats
 * into a total that is off by 0.000000001 of a cent; this refuses to.
 */
export function sumCents(values: readonly number[], label = 'amount'): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total += assertCents(values[i], `${label}[${i}]`);
  }
  if (!Number.isSafeInteger(total)) {
    throw new MoneyError(`${label} sum overflowed the safe integer range`);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------

/**
 * How a fractional cent becomes a whole one.
 *
 *   - `half-up`             — ties go toward +∞ (`0.5 -> 1`, `-0.5 -> 0`). JS's
 *                             `Math.round`, and the platform default for prices.
 *   - `half-away-from-zero` — ties grow in magnitude (`-0.5 -> -1`). What a
 *                             human means by "round a refund up".
 *   - `half-even`           — banker's rounding: ties go to the even neighbour.
 *                             Removes the upward bias when rounding many rows.
 *   - `toward-zero`         — truncate. Never charge for a fraction.
 *   - `floor` / `ceil`      — always down / always up.
 */
export type RoundingMode =
  | 'half-up'
  | 'half-away-from-zero'
  | 'half-even'
  | 'toward-zero'
  | 'floor'
  | 'ceil';

/**
 * Round an exact rational `floorQuotient + remainder/denominator` to an integer.
 * Kept separate from float rounding because the callers that need it most
 * (percentages, proration) can compute the remainder exactly, and a tie that is
 * genuinely a tie must not be decided by binary representation error.
 */
function roundQuotient(
  floorQuotient: number,
  remainder: number,
  denominator: number,
  mode: RoundingMode,
): number {
  if (remainder === 0) return floorQuotient;
  const twice = remainder * 2;
  const isTie = twice === denominator;
  const above = twice > denominator;
  const up = floorQuotient + 1;

  switch (mode) {
    case 'floor':
      return floorQuotient;
    case 'ceil':
      return up;
    case 'toward-zero':
      // floorQuotient is already toward -∞; for a negative value that is away
      // from zero, so step back up.
      return floorQuotient < 0 ? up : floorQuotient;
    case 'half-up':
      return isTie || above ? up : floorQuotient;
    case 'half-away-from-zero':
      if (above) return up;
      if (!isTie) return floorQuotient;
      // A tie on a negative value sits between two negatives; away from zero is
      // the lower (more negative) one.
      return floorQuotient < 0 ? floorQuotient : up;
    case 'half-even':
      if (above) return up;
      if (!isTie) return floorQuotient;
      return floorQuotient % 2 === 0 ? floorQuotient : up;
  }
}

/**
 * Round a possibly-fractional cent value to a whole cent. Prefer `applyPercent`
 * / `prorate` when the fraction comes from a ratio — they round exactly, this
 * one can only round what the float already lost.
 */
export function roundTo(value: number, mode: RoundingMode = 'half-up'): number {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`cannot round a non-finite amount: ${String(value)}`);
  }
  const floorQuotient = Math.floor(value);
  const fraction = value - floorQuotient;
  if (fraction === 0) return floorQuotient;
  // Scale the fraction to an exact-ish integer remainder over 1e9. Ties that
  // matter (exactly .5) survive the scaling; anything finer is noise either way.
  const denominator = 1_000_000_000;
  const remainder = Math.round(fraction * denominator);
  if (remainder === denominator) return floorQuotient + 1;
  return roundQuotient(floorQuotient, remainder, denominator, mode);
}

/**
 * Round a (possibly fractional) cent value to a whole integer cent using
 * half-up rounding. The canonical rounding for pricing maths — kept as its own
 * name because it is imported all over `pricing.ts` and reads better there than
 * `roundTo(x, 'half-up')`.
 */
export const roundCents = (cents: number): number => roundTo(cents, 'half-up');

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `-12.34` / `$1,234.56` / `.5` — sign, whole part, optional fraction. */
const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/**
 * A number as the decimal text the user most likely meant. `toPrecision(15)`
 * strips the binary noise (`1.005` prints as `1.00500000000000`) while keeping
 * every digit anyone could have typed; anything non-finite or big enough to
 * print in exponent form comes back as text the parser will reject.
 */
function decimalText(value: number): string {
  if (!Number.isFinite(value)) return '';
  return Number(value.toPrecision(15)).toString();
}

/**
 * Parse a human-entered dollar amount into integer cents, exactly.
 *
 * `toCents` (`Math.round(dollars * 100)`) is fine for values that survive a
 * float round-trip and wrong for the ones that do not: `toCents(1.005)` is
 * `100`, one cent short of what the operator typed. This parses the *decimal
 * text*, so what you see is what you get. Accepts `$`, thousands separators and
 * surrounding whitespace; rejects anything else rather than guessing.
 *
 * More than two decimal places round half-up on the magnitude, so `-1.005`
 * becomes `-101` — "round it up" means the same thing on a refund as on a
 * charge.
 */
export function centsFromDecimal(input: string | number): number {
  const raw = typeof input === 'number' ? decimalText(input) : input;

  const cleaned = raw.replace(/[$,\s]/g, '');
  const match = cleaned.match(DECIMAL_RE);
  if (!match || (!match[2] && !match[3])) {
    throw new MoneyError(`not a valid money amount: ${JSON.stringify(input)}`);
  }

  const whole = match[2] || '0';
  const fraction = match[3] ?? '';
  const wholeCents = Number(whole) * 100;
  const fractionCents = Number((fraction + '00').slice(0, 2));
  let magnitude = wholeCents + fractionCents;

  const beyond = fraction.slice(2);
  if (beyond && Number(beyond[0]) >= 5) magnitude += 1;

  if (!Number.isSafeInteger(magnitude)) {
    throw new MoneyError(`money amount is too large to represent in cents: ${cleaned}`);
  }
  return match[1] === '-' ? -magnitude : magnitude;
}

// ---------------------------------------------------------------------------
// Percentages and proration
// ---------------------------------------------------------------------------

/** The largest denominator `percentToRational` will build — 4 decimal places of percent. */
const MAX_PERCENT_DECIMALS = 4;

/**
 * Express a percentage as an exact fraction of one: `8.5` becomes
 * `{ numerator: 85, denominator: 1000 }`. Integer maths from here on, so no
 * float ever touches the multiplication.
 */
export function percentToRational(percent: number | string): {
  numerator: number;
  denominator: number;
} {
  const text = typeof percent === 'number' ? decimalText(percent) : percent.trim().replace(/%$/, '');

  const match = text.match(DECIMAL_RE);
  if (!match || (!match[2] && !match[3])) {
    throw new MoneyError(`not a valid percentage: ${JSON.stringify(percent)}`);
  }
  const fraction = match[3] ?? '';
  if (fraction.length > MAX_PERCENT_DECIMALS) {
    throw new MoneyError(
      `percentage has more than ${MAX_PERCENT_DECIMALS} decimal places: ${JSON.stringify(percent)}`,
    );
  }

  const digits = `${match[2] || '0'}${fraction}`;
  const magnitude = Number(digits);
  if (!Number.isSafeInteger(magnitude)) {
    throw new MoneyError(`percentage is out of range: ${JSON.stringify(percent)}`);
  }
  return {
    numerator: match[1] === '-' ? -magnitude : magnitude,
    denominator: 10 ** fraction.length * 100,
  };
}

/**
 * Exact `product / denominator`, rounded. Both arguments must be safe integers;
 * the quotient is corrected by hand because `Math.floor(a / b)` on floats can
 * land one off at a boundary, and this is the boundary that costs a penny.
 */
function divideRounded(product: number, denominator: number, mode: RoundingMode): number {
  if (denominator === 0) throw new MoneyError('cannot divide money by zero');
  if (!Number.isSafeInteger(product)) {
    throw new MoneyError('money calculation overflowed the safe integer range');
  }
  // Normalize so the remainder is always in [0, denominator).
  const sign = denominator < 0 ? -1 : 1;
  const p = product * sign;
  const d = denominator * sign;

  let floorQuotient = Math.floor(p / d);
  while (floorQuotient * d > p) floorQuotient--;
  while ((floorQuotient + 1) * d <= p) floorQuotient++;

  return roundQuotient(floorQuotient, p - floorQuotient * d, d, mode);
}

/**
 * Apply a percentage to an amount: `applyPercent(2_01, 0.5)` is the 0.5%
 * processing fee on $2.01 — 1 cent, not 0, because the exact value is 1.005
 * cents and half-up rounds it up.
 *
 * `percent` is a percentage, not a ratio: pass `8.5` for 8.5%.
 */
export function applyPercent(
  cents: number,
  percent: number | string,
  mode: RoundingMode = 'half-up',
): number {
  assertCents(cents, 'amount');
  const { numerator, denominator } = percentToRational(percent);
  return divideRounded(cents * numerator, denominator, mode);
}

/**
 * Apply a rate in basis points (1 bp = 0.01%). Processor pricing is quoted this
 * way (290 bp + 30c), and integer basis points cannot be mis-typed as a float.
 */
export function applyBasisPoints(
  cents: number,
  basisPoints: number,
  mode: RoundingMode = 'half-up',
): number {
  assertCents(cents, 'amount');
  assertCents(basisPoints, 'basisPoints');
  return divideRounded(cents * basisPoints, 10_000, mode);
}

/**
 * `cents * numerator / denominator`, rounded exactly — the honest way to take a
 * share of an amount (a per-seat portion of an order, a partial-day refund).
 * For splitting a total across several parties use `allocate`, which guarantees
 * the parts add back up; calling this per party does not.
 */
export function prorate(
  cents: number,
  numerator: number,
  denominator: number,
  mode: RoundingMode = 'half-up',
): number {
  assertCents(cents, 'amount');
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    throw new MoneyError('proration ratio must be finite');
  }
  if (denominator === 0) throw new MoneyError('cannot prorate by a zero denominator');
  if (Number.isInteger(numerator) && Number.isInteger(denominator)) {
    return divideRounded(cents * numerator, denominator, mode);
  }
  return roundTo((cents * numerator) / denominator, mode);
}

// ---------------------------------------------------------------------------
// Allocation — the part that must never lose a penny
// ---------------------------------------------------------------------------

/**
 * Split `totalCents` across `weights` so that the parts sum to *exactly*
 * `totalCents`, using the largest-remainder method.
 *
 * Each part is `floor(total * weight / totalWeight)`, then the leftover pennies
 * go one each to the parts with the largest discarded fraction, ties broken by
 * position. So `allocate(500, [1, 1, 1])` is `[167, 167, 166]` — not three
 * `166`s that lose 2c, and not three `167`s that invent 1c.
 *
 * Negative totals (a refund being spread back over the same weights) are
 * allocated on the magnitude and negated, so `allocate(-500, [1,1,1])` mirrors
 * the positive case exactly and a charge and its full refund always cancel.
 *
 * Weights must be finite and non-negative; they need not be integers or sum to
 * anything in particular. All-zero weights fall back to an even split, because
 * "nobody has any share of this" still has to put the money somewhere.
 */
export function allocate(totalCents: number, weights: readonly number[]): number[] {
  assertCents(totalCents, 'totalCents');
  if (weights.length === 0) {
    if (totalCents !== 0) {
      throw new MoneyError('cannot allocate a non-zero total across zero parts');
    }
    return [];
  }

  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]!;
    if (!Number.isFinite(w) || w < 0) {
      throw new MoneyError(`allocation weight[${i}] must be finite and non-negative, got ${w}`);
    }
  }

  if (totalCents < 0) return allocate(-totalCents, weights).map((part) => -part);

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) return split(totalCents, weights.length);

  const parts: number[] = new Array(weights.length);
  const fractions: number[] = new Array(weights.length);
  let allocated = 0;
  for (let i = 0; i < weights.length; i++) {
    const numerator = totalCents * weights[i]!;
    if (!Number.isFinite(numerator)) {
      throw new MoneyError('allocation overflowed — reduce the weights or the total');
    }
    const base = Math.floor(numerator / totalWeight);
    parts[i] = base;
    fractions[i] = numerator - base * totalWeight;
    allocated += base;
  }

  // Whatever floor() discarded, handed out one penny at a time. `remainder` is
  // computed from the parts we actually produced (not from theory), so float
  // slop in a weight can never make the result fail to sum.
  const remainder = totalCents - allocated;
  const order = parts
    .map((_, i) => i)
    .sort((a, b) => fractions[b]! - fractions[a]! || a - b);

  for (let i = 0; i < remainder; i++) {
    const at = order[i % order.length]!;
    parts[at] = parts[at]! + 1;
  }
  // Only reachable if float maths in a weight rounded a base up: take the penny
  // back from the parts with the smallest discarded fraction.
  for (let i = 0; i < -remainder; i++) {
    const at = order[order.length - 1 - (i % order.length)]!;
    parts[at] = parts[at]! - 1;
  }

  return parts;
}

/**
 * Split a total into `parts` equal shares, remainder pennies going to the
 * earliest parts: `split(1000, 3)` is `[334, 333, 333]`. Same guarantee as
 * `allocate` — the shares sum to exactly the total.
 */
export function split(totalCents: number, parts: number): number[] {
  assertCents(totalCents, 'totalCents');
  if (!Number.isSafeInteger(parts) || parts <= 0) {
    throw new MoneyError(`cannot split into ${parts} parts`);
  }
  if (totalCents < 0) return split(-totalCents, parts).map((p) => -p);

  const base = Math.floor(totalCents / parts);
  const remainder = totalCents - base * parts;
  return Array.from({ length: parts }, (_, i) => (i < remainder ? base + 1 : base));
}

// ---------------------------------------------------------------------------
// Verification — does what we think we have match what is there?
// ---------------------------------------------------------------------------

/** The result of comparing two amounts that are supposed to agree. */
export interface Variance {
  expectedCents: number;
  actualCents: number;
  /** `actual − expected`. Positive means there is more than expected. */
  deltaCents: number;
  /** Magnitude of the delta — what a report shows as "off by". */
  magnitudeCents: number;
  balanced: boolean;
  direction: 'over' | 'under' | 'exact';
}

/**
 * Compare an expected amount against an actual one. Used wherever two ledgers
 * must agree — our payments vs the processor's statement, an order's total vs
 * the sum of its lines, a gift card's balance vs its redemptions.
 *
 * `tolerance` exists for reconciling against a source that legitimately rounds
 * (a bank statement in whole dollars); it defaults to 0 because for our own
 * data any difference at all is a bug worth seeing.
 */
export function compareCents(
  expectedCents: number,
  actualCents: number,
  toleranceCents = 0,
): Variance {
  assertCents(expectedCents, 'expectedCents');
  assertCents(actualCents, 'actualCents');
  assertCents(toleranceCents, 'toleranceCents');
  const deltaCents = actualCents - expectedCents;
  const magnitudeCents = Math.abs(deltaCents);
  return {
    expectedCents,
    actualCents,
    deltaCents,
    magnitudeCents,
    balanced: magnitudeCents <= Math.abs(toleranceCents),
    direction: deltaCents > 0 ? 'over' : deltaCents < 0 ? 'under' : 'exact',
  };
}

/** A total checked against the components it is supposed to be the sum of. */
export interface TotalCheck extends Variance {
  components: readonly number[];
}

/**
 * Verify that a stored total equals the sum of its parts. This is the check
 * that catches a drifting ledger early: an order's `total_cents` against its
 * line items, `amount_paid_cents` against its payments, a payout against the
 * transactions in it.
 */
export function verifyTotal(
  components: readonly number[],
  totalCents: number,
  toleranceCents = 0,
): TotalCheck {
  const expected = sumCents(components, 'component');
  return { ...compareCents(expected, totalCents, toleranceCents), components };
}

/**
 * Throw unless the total equals the sum of its components. For the places that
 * must not proceed on a broken total — writing a payment, closing a day — where
 * a wrong number is worse than a failed request.
 */
export function assertBalanced(
  components: readonly number[],
  totalCents: number,
  label = 'total',
): void {
  const check = verifyTotal(components, totalCents);
  if (!check.balanced) {
    throw new MoneyError(
      `${label} does not balance: components sum to ${check.expectedCents} but ${label} is ${check.actualCents} (off by ${check.deltaCents})`,
    );
  }
}
