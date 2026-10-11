import { describe, it, expect } from 'vitest';
import {
  computeCancellationRefund,
  type CancellationPolicy,
} from './cancellation.js';

// Standard generic policy mirroring the lsra seed: 168->100, 24->50, 0->0,
// no fee, per-order, self-cancel 24h, card_then_gift.
const BASE: CancellationPolicy = {
  tiers: [
    { min_hours_before: 168, refund_percent: 100 },
    { min_hours_before: 24, refund_percent: 50 },
    { min_hours_before: 0, refund_percent: 0 },
  ],
  cancellation_fee_cents: 0,
  fee_scope: 'order',
  self_cancel_hours: 24,
  refund_method: 'card_then_gift',
};

// Fixed reference "now" so tests are deterministic.
const NOW = new Date('2026-06-01T12:00:00.000Z');
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3600_000);

function run(policy: CancellationPolicy | null, hoursUntilStart: number, amountPaidCents: number, guestCount?: number) {
  return computeCancellationRefund({
    policy,
    startsAt: hoursFromNow(hoursUntilStart),
    now: NOW,
    amountPaidCents,
    guestCount,
  });
}

describe('computeCancellationRefund — tier selection', () => {
  it('well before start -> top (100%) tier', () => {
    const r = run(BASE, 200, 10_000);
    expect(r.tierPercent).toBe(100);
    expect(r.refundCents).toBe(10_000);
  });

  it('exactly at the 168h boundary -> 100% (>= is inclusive)', () => {
    const r = run(BASE, 168, 10_000);
    expect(r.tierPercent).toBe(100);
    expect(r.refundCents).toBe(10_000);
  });

  it('just under 168h -> drops to the 50% tier', () => {
    const r = run(BASE, 167.99, 10_000);
    expect(r.tierPercent).toBe(50);
    expect(r.refundCents).toBe(5_000);
  });

  it('middle of the 50% band', () => {
    const r = run(BASE, 100, 10_000);
    expect(r.tierPercent).toBe(50);
    expect(r.refundCents).toBe(5_000);
  });

  it('exactly at the 24h boundary -> 50% (inclusive)', () => {
    const r = run(BASE, 24, 10_000);
    expect(r.tierPercent).toBe(50);
    expect(r.refundCents).toBe(5_000);
  });

  it('just under 24h -> 0% tier', () => {
    const r = run(BASE, 23.99, 10_000);
    expect(r.tierPercent).toBe(0);
    expect(r.refundCents).toBe(0);
  });

  it('exactly at start (0h) -> 0% tier (inclusive)', () => {
    const r = run(BASE, 0, 10_000);
    expect(r.tierPercent).toBe(0);
    expect(r.refundCents).toBe(0);
  });

  it('after start (negative hours) -> 0%, no tier qualifies', () => {
    const r = run(BASE, -5, 10_000);
    expect(r.tierPercent).toBe(0);
    expect(r.refundCents).toBe(0);
  });

  it('after start with NO 0h floor tier -> still 0%', () => {
    const policy: CancellationPolicy = {
      ...BASE,
      tiers: [
        { min_hours_before: 168, refund_percent: 100 },
        { min_hours_before: 24, refund_percent: 50 },
      ],
    };
    const r = run(policy, -1, 10_000);
    expect(r.tierPercent).toBe(0);
    expect(r.refundCents).toBe(0);
  });

  it('unsorted tiers select the same way (sort-independent)', () => {
    const policy: CancellationPolicy = {
      ...BASE,
      tiers: [
        { min_hours_before: 0, refund_percent: 0 },
        { min_hours_before: 168, refund_percent: 100 },
        { min_hours_before: 24, refund_percent: 50 },
      ],
    };
    expect(run(policy, 100, 10_000).tierPercent).toBe(50);
    expect(run(policy, 300, 10_000).tierPercent).toBe(100);
  });

  it('empty tiers -> 0%', () => {
    const policy: CancellationPolicy = { ...BASE, tiers: [] };
    const r = run(policy, 500, 10_000);
    expect(r.tierPercent).toBe(0);
    expect(r.refundCents).toBe(0);
  });
});

describe('computeCancellationRefund — percentage math', () => {
  it('50% of an odd amount rounds half-up (exact-percent helper)', () => {
    // 50% of 2_001 = 1000.5 -> 1001 half-up.
    const r = run(BASE, 100, 2_001);
    expect(r.tierPercent).toBe(50);
    expect(r.refundCents).toBe(1_001);
  });

  it('100% returns the full amount paid', () => {
    const r = run(BASE, 300, 7_777);
    expect(r.refundCents).toBe(7_777);
  });
});

describe('computeCancellationRefund — fees', () => {
  const FEE: CancellationPolicy = { ...BASE, cancellation_fee_cents: 500 };

  it('per-order fee is withheld once regardless of guest count', () => {
    const r = computeCancellationRefund({
      policy: FEE,
      startsAt: hoursFromNow(300),
      now: NOW,
      amountPaidCents: 10_000,
      guestCount: 4,
    });
    expect(r.tierPercent).toBe(100);
    expect(r.feeCents).toBe(500);
    expect(r.refundCents).toBe(9_500);
  });

  it('per-guest fee multiplies by guest count', () => {
    const policy: CancellationPolicy = { ...FEE, fee_scope: 'guest' };
    const r = computeCancellationRefund({
      policy,
      startsAt: hoursFromNow(300),
      now: NOW,
      amountPaidCents: 10_000,
      guestCount: 3,
    });
    expect(r.feeCents).toBe(1_500);
    expect(r.refundCents).toBe(8_500);
  });

  it('per-guest fee defaults to 1 guest when guestCount omitted', () => {
    const policy: CancellationPolicy = { ...FEE, fee_scope: 'guest' };
    const r = run(policy, 300, 10_000);
    expect(r.feeCents).toBe(500);
    expect(r.refundCents).toBe(9_500);
  });

  it('fee is applied against the discounted (post-tier) gross, not amount paid', () => {
    // 50% of 10_000 = 5_000 gross, minus 500 fee = 4_500.
    const r = run(FEE, 100, 10_000);
    expect(r.tierPercent).toBe(50);
    expect(r.feeCents).toBe(500);
    expect(r.refundCents).toBe(4_500);
  });

  it('fee larger than gross refund is clamped to the gross (refund never negative)', () => {
    const policy: CancellationPolicy = { ...BASE, cancellation_fee_cents: 9_999 };
    // 50% of 1_000 = 500 gross; fee clamps to 500; refund 0.
    const r = run(policy, 100, 1_000);
    expect(r.feeCents).toBe(500);
    expect(r.refundCents).toBe(0);
  });

  it('per-guest fee across many guests still clamps to gross', () => {
    const policy: CancellationPolicy = { ...BASE, cancellation_fee_cents: 500, fee_scope: 'guest' };
    // 100% of 1_000 gross; 10 guests * 500 = 5_000 fee -> clamps to 1_000; refund 0.
    const r = computeCancellationRefund({
      policy,
      startsAt: hoursFromNow(300),
      now: NOW,
      amountPaidCents: 1_000,
      guestCount: 10,
    });
    expect(r.feeCents).toBe(1_000);
    expect(r.refundCents).toBe(0);
  });

  it('negative configured fee is treated as zero', () => {
    const policy: CancellationPolicy = { ...BASE, cancellation_fee_cents: -500 };
    const r = run(policy, 300, 10_000);
    expect(r.feeCents).toBe(0);
    expect(r.refundCents).toBe(10_000);
  });
});

describe('computeCancellationRefund — clamping & edges', () => {
  it('zero amount paid -> zero refund', () => {
    const r = run(BASE, 300, 0);
    expect(r.refundCents).toBe(0);
    expect(r.feeCents).toBe(0);
  });

  it('refund never exceeds amount paid', () => {
    const r = run(BASE, 300, 12_345);
    expect(r.refundCents).toBeLessThanOrEqual(12_345);
    expect(r.refundCents).toBe(12_345);
  });
});

describe('computeCancellationRefund — self-cancel window', () => {
  it('well before cutoff -> within window true', () => {
    expect(run(BASE, 100, 10_000).withinSelfCancelWindow).toBe(true);
  });

  it('exactly at the cutoff (24h) -> within window true (inclusive)', () => {
    expect(run(BASE, 24, 10_000).withinSelfCancelWindow).toBe(true);
  });

  it('just inside the cutoff -> within window false', () => {
    expect(run(BASE, 23.99, 10_000).withinSelfCancelWindow).toBe(false);
  });

  it('after start -> within window false', () => {
    expect(run(BASE, -1, 10_000).withinSelfCancelWindow).toBe(false);
  });

  it('self-cancel window is independent of refund tier', () => {
    // 200h out: refund 100% AND within window.
    const r = run(BASE, 200, 10_000);
    expect(r.refundCents).toBe(10_000);
    expect(r.withinSelfCancelWindow).toBe(true);
  });
});

describe('computeCancellationRefund — no policy', () => {
  it('null policy -> zero everything, not self-cancelable', () => {
    const r = run(null, 300, 10_000);
    expect(r).toEqual({
      refundCents: 0,
      feeCents: 0,
      tierPercent: 0,
      withinSelfCancelWindow: false,
    });
  });

  it('undefined policy -> zero everything', () => {
    const r = computeCancellationRefund({
      policy: undefined,
      startsAt: hoursFromNow(300),
      now: NOW,
      amountPaidCents: 10_000,
    });
    expect(r.refundCents).toBe(0);
    expect(r.withinSelfCancelWindow).toBe(false);
  });
});
