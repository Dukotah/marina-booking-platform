import { describe, expect, it } from 'vitest';
import {
  computeDelta,
  previousPeriod,
  resolveDateBasis,
  rollUpByLocation,
  summarizePayments,
  aggregateRefunds,
  REFUND_REASON_NONE,
  type LocationMetricRow,
  type PaymentRow,
  type RefundRow,
} from './reports.js';

describe('resolveDateBasis', () => {
  it('accepts known bases', () => {
    expect(resolveDateBasis('order')).toBe('order');
    expect(resolveDateBasis('appointment')).toBe('appointment');
  });

  it('defaults to order for missing/unknown', () => {
    expect(resolveDateBasis(undefined)).toBe('order');
    expect(resolveDateBasis('')).toBe('order');
    expect(resolveDateBasis('nonsense')).toBe('order');
  });
});

describe('computeDelta', () => {
  it('computes an increase', () => {
    const d = computeDelta(150, 100);
    expect(d.absolute).toBe(50);
    expect(d.ratio).toBeCloseTo(0.5);
    expect(d.direction).toBe('up');
  });

  it('computes a decrease', () => {
    const d = computeDelta(80, 100);
    expect(d.absolute).toBe(-20);
    expect(d.ratio).toBeCloseTo(-0.2);
    expect(d.direction).toBe('down');
  });

  it('reports flat when equal', () => {
    const d = computeDelta(100, 100);
    expect(d.absolute).toBe(0);
    expect(d.ratio).toBe(0);
    expect(d.direction).toBe('flat');
  });

  it('returns null ratio (not Infinity) against a zero base', () => {
    const d = computeDelta(500, 0);
    expect(d.absolute).toBe(500);
    expect(d.ratio).toBeNull();
    expect(d.direction).toBe('up');
  });

  it('handles both zero', () => {
    const d = computeDelta(0, 0);
    expect(d.absolute).toBe(0);
    expect(d.ratio).toBeNull();
    expect(d.direction).toBe('flat');
  });
});

describe('previousPeriod', () => {
  it('returns the immediately preceding window of equal length', () => {
    const start = new Date('2026-06-01T00:00:00.000Z');
    const endExclusive = new Date('2026-06-08T00:00:00.000Z'); // 7-day window
    const prev = previousPeriod(start, endExclusive);
    expect(prev.endExclusive.getTime()).toBe(start.getTime());
    expect(prev.start.toISOString()).toBe('2026-05-25T00:00:00.000Z');
    // Same span.
    expect(prev.endExclusive.getTime() - prev.start.getTime()).toBe(
      endExclusive.getTime() - start.getTime(),
    );
  });
});

describe('summarizePayments', () => {
  it('returns a zero-filled row for every method with no data', () => {
    const s = summarizePayments([]);
    expect(s.byMethod).toHaveLength(4);
    expect(s.byMethod.map((m) => m.method)).toEqual(['CARD', 'CASH', 'GIFT_CARD', 'COMP']);
    expect(s.totals.collectedCents).toBe(0);
    expect(s.totals.count).toBe(0);
  });

  it('rolls up collected/refunded/net by method', () => {
    const rows: PaymentRow[] = [
      { method: 'CARD', amount_cents: 10_000, refunded_cents: 0 },
      { method: 'CARD', amount_cents: 5_000, refunded_cents: 1_000 },
      { method: 'CASH', amount_cents: 2_000, refunded_cents: 0 },
      { method: 'GIFT_CARD', amount_cents: 3_000, refunded_cents: 0 },
    ];
    const s = summarizePayments(rows);
    const card = s.byMethod.find((m) => m.method === 'CARD')!;
    expect(card.collectedCents).toBe(15_000);
    expect(card.refundedCents).toBe(1_000);
    expect(card.netCents).toBe(14_000);
    expect(card.count).toBe(2);

    expect(s.totals.collectedCents).toBe(20_000);
    expect(s.totals.refundedCents).toBe(1_000);
    expect(s.totals.netCents).toBe(19_000);
    expect(s.totals.count).toBe(4);
  });

  it('buckets an unknown method under COMP rather than dropping it', () => {
    const s = summarizePayments([
      { method: 'BITCOIN', amount_cents: 999, refunded_cents: 0 },
    ]);
    const comp = s.byMethod.find((m) => m.method === 'COMP')!;
    expect(comp.collectedCents).toBe(999);
    expect(s.totals.collectedCents).toBe(999);
  });
});

describe('rollUpByLocation', () => {
  const rows: LocationMetricRow[] = [
    { locationId: 'loc-a', locationName: 'North Marina', grossCents: 30000, orders: 3, capacityBooked: 15, capacityTotal: 30 },
    { locationId: 'loc-b', locationName: 'South Marina', grossCents: 10000, orders: 1, capacityBooked: 5, capacityTotal: 20 },
  ];

  it('derives occupancy, revenue share, and combined totals', () => {
    const rollup = rollUpByLocation(rows);
    expect(rollup.totals.grossCents).toBe(40000);
    expect(rollup.totals.orders).toBe(4);
    expect(rollup.totals.locations).toBe(2);
    // Combined occupancy = 20 / 50 = 0.4
    expect(rollup.totals.occupancy).toBeCloseTo(0.4, 5);
    // Sorted by gross desc: North first.
    expect(rollup.rows[0]!.locationId).toBe('loc-a');
    expect(rollup.rows[0]!.occupancy).toBeCloseTo(0.5, 5);
    expect(rollup.rows[0]!.revenueShare).toBeCloseTo(0.75, 5);
    expect(rollup.rows[1]!.revenueShare).toBeCloseTo(0.25, 5);
  });

  it('merges rows that share a location id', () => {
    const dup: LocationMetricRow[] = [
      { locationId: 'loc-a', locationName: 'North', grossCents: 100, orders: 1, capacityBooked: 1, capacityTotal: 2 },
      { locationId: 'loc-a', locationName: 'North', grossCents: 200, orders: 2, capacityBooked: 3, capacityTotal: 4 },
    ];
    const rollup = rollUpByLocation(dup);
    expect(rollup.rows).toHaveLength(1);
    expect(rollup.rows[0]!.grossCents).toBe(300);
    expect(rollup.rows[0]!.orders).toBe(3);
    expect(rollup.rows[0]!.capacityBooked).toBe(4);
  });

  it('is graceful with no data (zeros, no divide-by-zero)', () => {
    const rollup = rollUpByLocation([]);
    expect(rollup.totals.grossCents).toBe(0);
    expect(rollup.totals.occupancy).toBe(0);
    expect(rollup.rows).toHaveLength(0);
  });

  it('buckets unassigned-location activity under a single null row', () => {
    const rollup = rollUpByLocation([
      { locationId: null, locationName: 'Unassigned', grossCents: 500, orders: 1, capacityBooked: 0, capacityTotal: 0 },
    ]);
    expect(rollup.rows[0]!.locationId).toBeNull();
    expect(rollup.rows[0]!.occupancy).toBe(0);
  });
});

describe('aggregateRefunds', () => {
  const rows: RefundRow[] = [
    { reason: 'Weather', amountCents: 5000, activityId: 'a1', activityName: 'Kayak' },
    { reason: 'weather', amountCents: 2500, activityId: 'a1', activityName: 'Kayak' },
    { reason: 'Customer request', amountCents: 3000, activityId: 'a2', activityName: 'Pontoon' },
    { reason: '  ', amountCents: 1000, activityId: null, activityName: 'Unassigned' },
    { reason: null, amountCents: 500, activityId: null, activityName: 'Unassigned' },
  ];

  it('groups by exact (trimmed, case-sensitive) reason', () => {
    const r = aggregateRefunds(rows);
    const weather = r.byReason.find((x) => x.reason === 'Weather');
    const weatherLower = r.byReason.find((x) => x.reason === 'weather');
    expect(weather).toEqual({ reason: 'Weather', amountCents: 5000, count: 1 });
    expect(weatherLower).toEqual({ reason: 'weather', amountCents: 2500, count: 1 });
  });

  it('buckets blank/null reasons under the NONE label and keeps them', () => {
    const r = aggregateRefunds(rows);
    const none = r.byReason.find((x) => x.reason === REFUND_REASON_NONE);
    expect(none).toEqual({ reason: REFUND_REASON_NONE, amountCents: 1500, count: 2 });
  });

  it('groups by activity (null folded into one bucket)', () => {
    const r = aggregateRefunds(rows);
    const unassigned = r.byActivity.find((x) => x.activityId === null);
    expect(unassigned).toEqual({
      activityId: null,
      activityName: 'Unassigned',
      amountCents: 1500,
      count: 2,
    });
  });

  it('computes grand totals and sorts by amount desc', () => {
    const r = aggregateRefunds(rows);
    expect(r.totals).toEqual({ amountCents: 12000, count: 5 });
    expect(r.byReason[0]!.amountCents).toBe(5000);
    expect(r.byActivity[0]!.amountCents).toBe(7500);
  });

  it('returns empty breakdowns and zero totals for no rows', () => {
    const r = aggregateRefunds([]);
    expect(r.byReason).toEqual([]);
    expect(r.byActivity).toEqual([]);
    expect(r.totals).toEqual({ amountCents: 0, count: 0 });
  });
});
