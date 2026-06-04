import { describe, expect, it } from 'vitest';
import { formatUSD, fromCents, roundCents, toCents } from './money.js';

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
