import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  allocate,
  applyBasisPoints,
  applyPercent,
  assertBalanced,
  assertCents,
  centsFromDecimal,
  compareCents,
  formatUSD,
  fromCents,
  isCents,
  percentToRational,
  prorate,
  roundCents,
  roundTo,
  split,
  sumCents,
  toCents,
  verifyTotal,
  type RoundingMode,
} from './money.js';

const MODES: RoundingMode[] = [
  'half-up',
  'half-away-from-zero',
  'half-even',
  'toward-zero',
  'floor',
  'ceil',
];

describe('toCents', () => {
  it('converts whole dollars to cents', () => {
    expect(toCents(10)).toBe(1000);
  });

  it('converts fractional dollars to cents, rounding half-up', () => {
    expect(toCents(10.005)).toBe(1001);
    expect(toCents(9.999)).toBe(1000);
  });

  it('handles zero and negative amounts', () => {
    expect(toCents(0)).toBe(0);
    expect(toCents(-3.5)).toBe(-350);
  });

  it('loses a cent on values that float multiplication rounds down — use centsFromDecimal', () => {
    // Documents the exact defect centsFromDecimal exists to fix: 1.005 * 100 is
    // 100.49999999999999 in binary, so this is 100 rather than 101.
    expect(toCents(1.005)).toBe(100);
    expect(centsFromDecimal(1.005)).toBe(101);
  });
});

describe('fromCents', () => {
  it('converts cents back to dollars', () => {
    expect(fromCents(1000)).toBe(10);
    expect(fromCents(1)).toBe(0.01);
  });

  it('round-trips with toCents for whole cent values', () => {
    expect(toCents(fromCents(3995))).toBe(3995);
  });
});

describe('isCents / assertCents', () => {
  it('accepts safe integers including negatives and zero', () => {
    expect(isCents(0)).toBe(true);
    expect(isCents(-2500)).toBe(true);
    expect(assertCents(1234)).toBe(1234);
  });

  it('rejects fractions, NaN, Infinity, and non-numbers', () => {
    for (const bad of [12.5, NaN, Infinity, -Infinity, '100', null, undefined, {}]) {
      expect(isCents(bad)).toBe(false);
      expect(() => assertCents(bad)).toThrow(MoneyError);
    }
  });

  it('rejects values beyond the safe integer range', () => {
    expect(isCents(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
  });

  it('names the offending field so the error is actionable', () => {
    expect(() => assertCents(1.5, 'amount_paid_cents')).toThrow(/amount_paid_cents/);
  });
});

describe('sumCents', () => {
  it('sums integer cents', () => {
    expect(sumCents([100, 250, -50])).toBe(300);
    expect(sumCents([])).toBe(0);
  });

  it('refuses a float term rather than producing a fractional total', () => {
    expect(() => sumCents([100, 0.5])).toThrow(MoneyError);
  });

  it('points at the index that is wrong', () => {
    expect(() => sumCents([100, 200, 1.5], 'payment')).toThrow(/payment\[2\]/);
  });
});

describe('roundTo', () => {
  it('half-up sends ties toward positive infinity', () => {
    expect(roundTo(0.5, 'half-up')).toBe(1);
    expect(roundTo(1.5, 'half-up')).toBe(2);
    expect(roundTo(2.5, 'half-up')).toBe(3);
    expect(roundTo(-0.5, 'half-up')).toBe(0);
    expect(roundTo(-1.5, 'half-up')).toBe(-1);
  });

  it('half-away-from-zero grows the magnitude on a tie', () => {
    expect(roundTo(0.5, 'half-away-from-zero')).toBe(1);
    expect(roundTo(-0.5, 'half-away-from-zero')).toBe(-1);
    expect(roundTo(-1.5, 'half-away-from-zero')).toBe(-2);
    expect(roundTo(-2.5, 'half-away-from-zero')).toBe(-3);
  });

  it("half-even (banker's) sends ties to the even neighbour", () => {
    expect(roundTo(0.5, 'half-even')).toBe(0);
    expect(roundTo(1.5, 'half-even')).toBe(2);
    expect(roundTo(2.5, 'half-even')).toBe(2);
    expect(roundTo(3.5, 'half-even')).toBe(4);
    expect(roundTo(-0.5, 'half-even')).toBe(0);
    expect(roundTo(-1.5, 'half-even')).toBe(-2);
    expect(roundTo(-2.5, 'half-even')).toBe(-2);
  });

  it('toward-zero truncates in both directions', () => {
    expect(roundTo(1.9, 'toward-zero')).toBe(1);
    expect(roundTo(-1.9, 'toward-zero')).toBe(-1);
    expect(roundTo(-0.1, 'toward-zero')).toBe(0);
  });

  it('floor and ceil never look at the tie', () => {
    expect(roundTo(1.5, 'floor')).toBe(1);
    expect(roundTo(-1.5, 'floor')).toBe(-2);
    expect(roundTo(1.5, 'ceil')).toBe(2);
    expect(roundTo(-1.5, 'ceil')).toBe(-1);
    expect(roundTo(1.0001, 'floor')).toBe(1);
    expect(roundTo(1.0001, 'ceil')).toBe(2);
  });

  it('leaves whole values alone under every mode', () => {
    for (const mode of MODES) {
      expect(roundTo(0, mode)).toBe(0);
      expect(roundTo(7, mode)).toBe(7);
      expect(roundTo(-7, mode)).toBe(-7);
    }
  });

  it('always returns an integer, for every mode and a spread of fractions', () => {
    for (const mode of MODES) {
      for (let n = -50; n <= 50; n++) {
        for (const frac of [0, 0.1, 0.25, 0.5, 0.75, 0.9]) {
          const out = roundTo(n + frac, mode);
          expect(Number.isInteger(out)).toBe(true);
          // Never moves more than one whole cent away from the input.
          expect(Math.abs(out - (n + frac))).toBeLessThan(1);
        }
      }
    }
  });

  it('rejects a non-finite amount instead of returning NaN', () => {
    expect(() => roundTo(NaN)).toThrow(MoneyError);
    expect(() => roundTo(Infinity)).toThrow(MoneyError);
  });
});

describe('roundCents', () => {
  it('rounds fractional cents half-up to an integer', () => {
    expect(roundCents(1234.5)).toBe(1235);
    expect(roundCents(1234.4)).toBe(1234);
  });

  it('leaves whole cents untouched', () => {
    expect(roundCents(5000)).toBe(5000);
    expect(roundCents(0)).toBe(0);
  });

  it('always returns an integer', () => {
    expect(Number.isInteger(roundCents(3237.5))).toBe(true);
  });

  it('matches Math.round, which the pricing code was written against', () => {
    for (let n = -1000; n <= 1000; n++) {
      const value = n / 4;
      const expected = Math.round(value);
      // Math.round(-0.25) is -0; roundCents normalizes that away (see below), so
      // compare numerically rather than by Object.is.
      expect(roundCents(value)).toBe(expected === 0 ? 0 : expected);
    }
  });

  it('never returns negative zero — a ledger has one zero', () => {
    expect(Object.is(roundCents(-0.25), 0)).toBe(true);
    expect(Object.is(Math.round(-0.25), -0)).toBe(true);
  });
});

describe('centsFromDecimal', () => {
  it('parses plain decimal text exactly', () => {
    expect(centsFromDecimal('0')).toBe(0);
    expect(centsFromDecimal('12')).toBe(1200);
    expect(centsFromDecimal('12.3')).toBe(1230);
    expect(centsFromDecimal('12.34')).toBe(1234);
    expect(centsFromDecimal('.5')).toBe(50);
    expect(centsFromDecimal('0.01')).toBe(1);
  });

  it('accepts the way people actually type money', () => {
    expect(centsFromDecimal('$1,234.56')).toBe(123456);
    expect(centsFromDecimal('  99.00  ')).toBe(9900);
    expect(centsFromDecimal('+7.25')).toBe(725);
  });

  it('handles negatives symmetrically', () => {
    expect(centsFromDecimal('-12.34')).toBe(-1234);
    expect(centsFromDecimal('-0.01')).toBe(-1);
    expect(centsFromDecimal('-1.005')).toBe(-101);
  });

  it('rounds a third decimal place half-up on the magnitude', () => {
    expect(centsFromDecimal('1.004')).toBe(100);
    expect(centsFromDecimal('1.005')).toBe(101);
    expect(centsFromDecimal('1.006')).toBe(101);
    expect(centsFromDecimal('0.999')).toBe(100);
  });

  it('parses numbers without the float multiplication error', () => {
    expect(centsFromDecimal(1.005)).toBe(101);
    expect(centsFromDecimal(10.005)).toBe(1001);
    expect(centsFromDecimal(2.675)).toBe(268);
    expect(centsFromDecimal(-2.675)).toBe(-268);
  });

  it('round-trips every cent value from 0 to 1000 through its formatted form', () => {
    for (let cents = 0; cents <= 1000; cents++) {
      expect(centsFromDecimal((cents / 100).toFixed(2))).toBe(cents);
      expect(centsFromDecimal(formatUSD(cents))).toBe(cents);
    }
  });

  it('rejects anything that is not a decimal amount', () => {
    for (const bad of ['', '   ', 'abc', '1.2.3', '--1', '1e5', '1/2', '12 34x', NaN, Infinity]) {
      expect(() => centsFromDecimal(bad as string | number), `${String(bad)} should be rejected`).toThrow(
        MoneyError,
      );
    }
  });

  it('is lenient about separators, since a stray one is a typo not a different amount', () => {
    expect(centsFromDecimal('12,')).toBe(1200);
    expect(centsFromDecimal('1,2,3')).toBe(12300);
  });
});

describe('percentToRational', () => {
  it('turns a percentage into an exact fraction of one', () => {
    expect(percentToRational(100)).toEqual({ numerator: 100, denominator: 100 });
    expect(percentToRational(8.5)).toEqual({ numerator: 85, denominator: 1000 });
    expect(percentToRational('8.25%')).toEqual({ numerator: 825, denominator: 10000 });
    expect(percentToRational(0)).toEqual({ numerator: 0, denominator: 100 });
  });

  it('keeps the sign for a discount expressed as a negative percentage', () => {
    expect(percentToRational(-10)).toEqual({ numerator: -10, denominator: 100 });
  });

  it('rejects more precision than a rate is ever quoted with', () => {
    expect(() => percentToRational('1.234567')).toThrow(MoneyError);
    expect(() => percentToRational('not a rate')).toThrow(MoneyError);
  });
});

describe('applyPercent', () => {
  it('applies a simple rate', () => {
    expect(applyPercent(10_000, 8.5)).toBe(850);
    expect(applyPercent(10_000, 0)).toBe(0);
    expect(applyPercent(0, 8.5)).toBe(0);
    expect(applyPercent(10_000, 100)).toBe(10_000);
  });

  it('rounds an exact half cent up rather than losing it to float error', () => {
    // 0.5% of $2.01 is exactly 1.005 cents. The naive `cents * pct / 100` gives
    // 1.0049999999999999 and rounds to 1 by luck; the exact path decides it.
    expect(applyPercent(201, 0.5)).toBe(1);
    // 8.5% of $1.00 is exactly 8.5 cents -> half-up -> 9.
    expect(applyPercent(100, 8.5)).toBe(9);
    expect(applyPercent(100, 8.5, 'floor')).toBe(8);
    expect(applyPercent(100, 8.5, 'half-even')).toBe(8);
    expect(applyPercent(300, 8.5, 'half-even')).toBe(26);
  });

  it('rounds negative amounts by the requested mode, not by accident', () => {
    expect(applyPercent(-100, 8.5, 'half-up')).toBe(-8);
    expect(applyPercent(-100, 8.5, 'half-away-from-zero')).toBe(-9);
    expect(applyPercent(-100, 8.5, 'floor')).toBe(-9);
    expect(applyPercent(-100, 8.5, 'ceil')).toBe(-8);
  });

  it('never differs from the exact value by a whole cent, across a sweep', () => {
    for (let cents = 0; cents <= 5000; cents += 7) {
      for (const pct of [0.5, 2.9, 7.25, 8.5, 15, 33.333]) {
        const exact = (cents * Number(pct)) / 100;
        const applied = applyPercent(cents, pct);
        expect(Number.isInteger(applied)).toBe(true);
        expect(Math.abs(applied - exact)).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
  });

  it('refuses a fractional amount', () => {
    expect(() => applyPercent(10.5, 8.5)).toThrow(MoneyError);
  });
});

describe('applyBasisPoints', () => {
  it('treats 100 bp as 1%', () => {
    expect(applyBasisPoints(10_000, 100)).toBe(100);
    expect(applyBasisPoints(10_000, 290)).toBe(290);
    expect(applyBasisPoints(0, 290)).toBe(0);
  });

  it('agrees with applyPercent on the same rate', () => {
    for (let cents = 0; cents <= 20_000; cents += 137) {
      expect(applyBasisPoints(cents, 290)).toBe(applyPercent(cents, 2.9));
    }
  });

  it('models the real processor charge: 2.9% + 30c', () => {
    const gross = 12_500;
    expect(applyBasisPoints(gross, 290) + 30).toBe(393);
  });

  it('requires integer basis points', () => {
    expect(() => applyBasisPoints(1000, 2.9)).toThrow(MoneyError);
  });
});

describe('prorate', () => {
  it('takes an exact share of an amount', () => {
    expect(prorate(1000, 1, 4)).toBe(250);
    expect(prorate(1000, 1, 3)).toBe(333);
    expect(prorate(1000, 2, 3)).toBe(667);
    expect(prorate(1000, 0, 3)).toBe(0);
  });

  it('rounds an exact half by the requested mode', () => {
    expect(prorate(1, 1, 2)).toBe(1);
    expect(prorate(1, 1, 2, 'floor')).toBe(0);
    expect(prorate(1, 1, 2, 'half-even')).toBe(0);
    expect(prorate(3, 1, 2, 'half-even')).toBe(2);
  });

  it('handles non-integer ratios (a partial day)', () => {
    expect(prorate(10_000, 1.5, 3)).toBe(5000);
  });

  it('refuses a zero denominator instead of returning Infinity', () => {
    expect(() => prorate(1000, 1, 0)).toThrow(MoneyError);
    expect(() => prorate(1000, NaN, 3)).toThrow(MoneyError);
  });
});

describe('allocate', () => {
  it('solves the classic remainder problem', () => {
    // The bug this whole function exists for: round(500/3) * 3 is 501.
    expect(allocate(500, [1, 1, 1])).toEqual([167, 167, 166]);
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(5, [3, 7])).toEqual([2, 3]);
  });

  it('allocates exactly when the split is clean', () => {
    expect(allocate(1000, [3, 1])).toEqual([750, 250]);
    expect(allocate(1000, [1])).toEqual([1000]);
    expect(allocate(0, [1, 2, 3])).toEqual([0, 0, 0]);
  });

  it('gives a zero-weight party nothing', () => {
    expect(allocate(1000, [1, 0, 1])).toEqual([500, 0, 500]);
  });

  it('splits evenly when every weight is zero — the money still has to land somewhere', () => {
    expect(allocate(100, [0, 0, 0])).toEqual([34, 33, 33]);
  });

  it('mirrors exactly under negation, so a charge and its refund cancel', () => {
    const weights = [5, 3, 1, 7];
    for (let total = 0; total <= 400; total += 13) {
      const positive = allocate(total, weights);
      const negative = allocate(-total, weights);
      expect(negative).toEqual(positive.map((p) => -p));
      expect(positive.map((p, i) => p + negative[i]!)).toEqual(weights.map(() => 0));
    }
  });

  it('always sums to exactly the total — exhaustively', () => {
    const weightSets = [
      [1, 1, 1],
      [1, 2],
      [3, 7],
      [1, 1, 1, 1, 1, 1, 1],
      [10, 1, 1],
      [0, 1, 0, 1],
      [0.5, 0.25, 0.25],
      [2.5, 7.5],
      [1],
    ];
    for (const weights of weightSets) {
      for (let total = -300; total <= 300; total++) {
        const parts = allocate(total, weights);
        expect(parts).toHaveLength(weights.length);
        expect(parts.every(Number.isInteger)).toBe(true);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it('keeps every part within one cent of its ideal share', () => {
    const weights = [1, 2, 3, 5, 8];
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    for (let total = 0; total <= 2000; total += 3) {
      const parts = allocate(total, weights);
      parts.forEach((part, i) => {
        const ideal = (total * weights[i]!) / totalWeight;
        expect(Math.abs(part - ideal)).toBeLessThan(1);
      });
    }
  });

  it('is deterministic — the same inputs always give the same answer', () => {
    const a = allocate(1000, [1, 1, 1, 1, 1, 1, 7]);
    const b = allocate(1000, [1, 1, 1, 1, 1, 1, 7]);
    expect(a).toEqual(b);
  });

  it('hands leftover pennies to the largest fractions first, ties by position', () => {
    // 10c over weights 1/1/2: ideals are 2.5, 2.5, 5 -> bases 2, 2, 5 leave one
    // penny. Parties 0 and 1 tie on the discarded half, so position breaks it and
    // the first one takes the penny.
    expect(allocate(10, [1, 1, 2])).toEqual([3, 2, 5]);
    // And with two pennies to give out, both tied parties get one.
    expect(allocate(11, [1, 1, 2])).toEqual([3, 3, 5]);
  });

  it('allocates nothing across no parties, and refuses to lose money doing it', () => {
    expect(allocate(0, [])).toEqual([]);
    expect(() => allocate(100, [])).toThrow(MoneyError);
  });

  it('rejects a negative or non-finite weight', () => {
    expect(() => allocate(100, [1, -1])).toThrow(MoneyError);
    expect(() => allocate(100, [1, NaN])).toThrow(MoneyError);
  });

  it('rejects a fractional total', () => {
    expect(() => allocate(100.5, [1, 1])).toThrow(MoneyError);
  });
});

describe('split', () => {
  it('splits evenly, remainder to the earliest parts', () => {
    expect(split(1000, 3)).toEqual([334, 333, 333]);
    expect(split(1000, 4)).toEqual([250, 250, 250, 250]);
    expect(split(1, 3)).toEqual([1, 0, 0]);
    expect(split(0, 3)).toEqual([0, 0, 0]);
  });

  it('mirrors under negation', () => {
    expect(split(-1000, 3)).toEqual([-334, -333, -333]);
  });

  it('always sums to the total — exhaustively', () => {
    for (let parts = 1; parts <= 12; parts++) {
      for (let total = -200; total <= 200; total++) {
        const shares = split(total, parts);
        expect(shares).toHaveLength(parts);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it('agrees with an equal-weight allocate', () => {
    for (let parts = 1; parts <= 8; parts++) {
      for (let total = 0; total <= 200; total += 7) {
        expect(split(total, parts)).toEqual(allocate(total, Array(parts).fill(1)));
      }
    }
  });

  it('refuses a nonsensical number of parts', () => {
    expect(() => split(100, 0)).toThrow(MoneyError);
    expect(() => split(100, -2)).toThrow(MoneyError);
    expect(() => split(100, 2.5)).toThrow(MoneyError);
  });
});

describe('compareCents', () => {
  it('reports a shortfall as under, with a signed delta', () => {
    const v = compareCents(10_000, 9_988);
    expect(v.deltaCents).toBe(-12);
    expect(v.magnitudeCents).toBe(12);
    expect(v.direction).toBe('under');
    expect(v.balanced).toBe(false);
  });

  it('reports a surplus as over', () => {
    const v = compareCents(10_000, 10_012);
    expect(v.deltaCents).toBe(12);
    expect(v.direction).toBe('over');
  });

  it('reports an exact match as balanced', () => {
    const v = compareCents(10_000, 10_000);
    expect(v).toMatchObject({ deltaCents: 0, magnitudeCents: 0, direction: 'exact', balanced: true });
  });

  it('honours a tolerance for a source that rounds', () => {
    expect(compareCents(10_000, 9_999, 1).balanced).toBe(true);
    expect(compareCents(10_000, 9_998, 1).balanced).toBe(false);
    // Direction still tells the truth even when the difference is tolerated.
    expect(compareCents(10_000, 9_999, 1).direction).toBe('under');
  });

  it('refuses to compare fractional amounts', () => {
    expect(() => compareCents(10.5, 10)).toThrow(MoneyError);
  });
});

describe('verifyTotal / assertBalanced', () => {
  it('confirms a total that is the sum of its parts', () => {
    const check = verifyTotal([1000, 250, 75], 1325);
    expect(check.balanced).toBe(true);
    expect(check.expectedCents).toBe(1325);
    expect(check.components).toEqual([1000, 250, 75]);
  });

  it('quantifies the drift when it is not', () => {
    const check = verifyTotal([1000, 250, 75], 1300);
    expect(check.balanced).toBe(false);
    expect(check.deltaCents).toBe(-25);
    expect(check.direction).toBe('under');
  });

  it('treats an empty component list as zero', () => {
    expect(verifyTotal([], 0).balanced).toBe(true);
    expect(verifyTotal([], 100).deltaCents).toBe(100);
  });

  it('assertBalanced passes silently and throws with the numbers in the message', () => {
    expect(() => assertBalanced([1000, 325], 1325, 'order total')).not.toThrow();
    expect(() => assertBalanced([1000, 325], 1300, 'order total')).toThrow(
      /order total does not balance.*1325.*1300.*-25/,
    );
  });

  it('proves an allocated split always balances back against its total', () => {
    for (let total = 0; total <= 1000; total += 11) {
      const parts = allocate(total, [3, 4, 5]);
      expect(verifyTotal(parts, total).balanced).toBe(true);
    }
  });
});

describe('formatUSD', () => {
  it('formats cents as a USD currency string', () => {
    expect(formatUSD(1000)).toBe('$10.00');
    expect(formatUSD(39768)).toBe('$397.68');
  });

  it('formats zero', () => {
    expect(formatUSD(0)).toBe('$0.00');
  });

  it('formats negative amounts (e.g. refunds)', () => {
    expect(formatUSD(-2500)).toBe('-$25.00');
  });

  it('inserts thousands separators', () => {
    expect(formatUSD(123456789)).toBe('$1,234,567.89');
  });
});
