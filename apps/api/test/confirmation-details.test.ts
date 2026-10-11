/**
 * Confirmation-detail formatting for customer-question answers echoed into the
 * booking confirmation email. PURE unit tests for formatAnswer plus a stubbed-db
 * test of loadConfirmationDetails' join/filter/order logic (no live Postgres).
 */
import { describe, it, expect } from 'vitest';
import {
  formatAnswer,
  loadConfirmationDetails,
  type OrderBundle,
} from '../src/services/notification-data.js';

describe('formatAnswer', () => {
  it('renders booleans (CHECKBOX) as Yes/No', () => {
    expect(formatAnswer(true)).toBe('Yes');
    expect(formatAnswer(false)).toBe('No');
  });

  it('joins array answers (multi-SELECT) with commas', () => {
    expect(formatAnswer(['A', 'B', 'C'])).toBe('A, B, C');
    expect(formatAnswer(['A', '', 'B'])).toBe('A, B');
  });

  it('stringifies NUMBER / DATE / PHONE scalars and trims text', () => {
    expect(formatAnswer(42)).toBe('42');
    expect(formatAnswer('2026-07-04')).toBe('2026-07-04');
    expect(formatAnswer('  (707) 555-0199  ')).toBe('(707) 555-0199');
  });

  it('renders null/undefined/empty as empty string', () => {
    expect(formatAnswer(null)).toBe('');
    expect(formatAnswer(undefined)).toBe('');
  });
});

describe('loadConfirmationDetails', () => {
  function stubDb(rows: Array<{ id: string; label: string }>) {
    return {
      customerQuestion: {
        // Mimic Prisma findMany returning only show_in_confirmation rows in the
        // requested order; we assert the service maps + filters answers correctly.
        findMany: async () => rows,
      },
    } as unknown as Parameters<typeof loadConfirmationDetails>[0];
  }

  function orderWith(answers: unknown): OrderBundle {
    return { question_answers: answers } as unknown as OrderBundle;
  }

  it('returns [] when the order has no answers', async () => {
    const db = stubDb([]);
    expect(await loadConfirmationDetails(db, orderWith(null))).toEqual([]);
    expect(await loadConfirmationDetails(db, orderWith({}))).toEqual([]);
  });

  it('maps flagged questions to label/value and drops blank answers', async () => {
    const db = stubDb([
      { id: 'q1', label: 'Trailer plate' },
      { id: 'q2', label: 'Need a guide?' },
      { id: 'q3', label: 'Empty one' },
    ]);
    const details = await loadConfirmationDetails(
      db,
      orderWith({ q1: '7ABC123', q2: true, q3: '' }),
    );
    expect(details).toEqual([
      { label: 'Trailer plate', value: '7ABC123' },
      { label: 'Need a guide?', value: 'Yes' },
    ]);
  });
});
