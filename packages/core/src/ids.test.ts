import { describe, expect, it } from 'vitest';
import { createId, generateOrderNumber } from './ids.js';

describe('createId', () => {
  it('returns a non-empty string', () => {
    const id = createId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('produces unique ids across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createId()));
    expect(ids.size).toBe(1000);
  });

  it('produces URL-safe ids (alphanumeric only)', () => {
    for (let i = 0; i < 50; i++) {
      expect(createId()).toMatch(/^[0-9a-z]+$/i);
    }
  });
});

describe('generateOrderNumber', () => {
  it('formats the canonical LSRA example', () => {
    // ("LSRA", 2026-06-04, 1) => "LSRA260604001"
    expect(generateOrderNumber('LSRA', new Date(2026, 5, 4), 1)).toBe(
      'LSRA260604001',
    );
  });

  it('uppercases and trims the location code', () => {
    expect(generateOrderNumber('  lsra  ', new Date(2026, 5, 4), 7)).toBe(
      'LSRA260604007',
    );
  });

  it('zero-pads the month and day', () => {
    expect(generateOrderNumber('AB', new Date(2026, 0, 9), 3)).toBe(
      'AB260109003',
    );
  });

  it('zero-pads the sequence to three digits', () => {
    expect(generateOrderNumber('AB', new Date(2026, 5, 4), 42)).toBe(
      'AB260604042',
    );
  });

  it('renders sequences above 999 at their natural width', () => {
    expect(generateOrderNumber('AB', new Date(2026, 5, 4), 1000)).toBe(
      'AB2606041000',
    );
  });

  it('uses the last two digits of the year', () => {
    expect(generateOrderNumber('X', new Date(2030, 11, 31), 5)).toBe(
      'X301231005',
    );
    // year 2000 -> "00"
    expect(generateOrderNumber('X', new Date(2000, 0, 1), 1)).toBe(
      'X000101001',
    );
  });

  it('truncates fractional sequence numbers and clamps negatives to zero', () => {
    expect(generateOrderNumber('AB', new Date(2026, 5, 4), 12.9)).toBe(
      'AB260604012',
    );
    expect(generateOrderNumber('AB', new Date(2026, 5, 4), -4)).toBe(
      'AB260604000',
    );
  });

  it('produces a string of the expected total length for a 3-digit seq', () => {
    // 4 (code) + 6 (date) + 3 (seq) = 13
    expect(generateOrderNumber('LSRA', new Date(2026, 5, 4), 1)).toHaveLength(
      13,
    );
  });
});
