/**
 * Channel distribution — pure unit tests. No database, no network.
 *
 * Two things are proved here:
 *
 *   1. THE COMMISSION MATHS, in integer cents. Rounding is half-up and happens
 *      per booking, commission can never exceed the gross or go negative, a
 *      partner-stated figure beats our configured percent, and a roll-up adds
 *      snapshots rather than re-deriving them.
 *   2. THE MOCK MARKETPLACE'S BEHAVIOUR: it sells only what was pushed, it sells
 *      from a snapshot that goes stale (so it can oversell — which is the whole
 *      reason the import re-checks capacity), it redelivers until acknowledged,
 *      it produces arrivals on a schedule against an injected clock, and guest
 *      cancellations arrive the same way bookings do.
 *
 * The state transitions are pure functions over plain JSON, so everything below
 * runs with no Prisma client and no Postgres.
 */
import { describe, it, expect } from 'vitest';
import {
  commissionCents,
  normalizeCommissionPercent,
  retailSchedule,
  settleChannelAmount,
  summarizeChannelBookings,
  type SummarizableBooking,
} from '../src/services/channels.js';
import type { InventoryListing } from '../src/services/channels.js';
import {
  acknowledgeNotices,
  advanceArrivals,
  applyPush,
  applySupplierCancel,
  drawInt,
  markDelivered,
  mockChannelConfig,
  mockInitialState,
  pendingNotices,
  queueBooking,
  queueGuestCancellation,
  retailQuote,
  toMockState,
  toPayload,
  xorshift32,
  type MockChannelState,
} from '../src/services/channel-mock.js';

// ===========================================================================
// Commission maths
// ===========================================================================

describe('commissionCents', () => {
  it('takes a whole percent of an integer-cent gross', () => {
    expect(commissionCents(10_000, 20)).toBe(2_000);
    expect(commissionCents(24_995, 30)).toBe(7_499); // 7498.5 -> half-up
  });

  it('rounds half-up, never truncating a half cent in the operator’s favour', () => {
    // 1 cent short of a clean split: 12345 * 25% = 3086.25 -> 3086.
    expect(commissionCents(12_345, 25)).toBe(3_086);
    // 10 * 25% = 2.5 -> 3.
    expect(commissionCents(10, 25)).toBe(3);
  });

  it('returns an integer for every percent from 0 to 100', () => {
    for (let pct = 0; pct <= 100; pct += 1) {
      const c = commissionCents(9_999, pct);
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(9_999);
    }
  });

  it('is zero for a zero rate, a zero gross, and nonsense input', () => {
    expect(commissionCents(10_000, 0)).toBe(0);
    expect(commissionCents(0, 20)).toBe(0);
    expect(commissionCents(-500, 20)).toBe(0);
    expect(commissionCents(Number.NaN, 20)).toBe(0);
    expect(commissionCents(10_000, Number.NaN)).toBe(0);
  });

  it('never pays out more than the gross', () => {
    expect(commissionCents(10_000, 100)).toBe(10_000);
    expect(commissionCents(10_000, 250)).toBe(10_000); // clamped to 100%
    expect(commissionCents(10_000, -30)).toBe(0);
  });
});

describe('normalizeCommissionPercent', () => {
  it('clamps to 0..100 and truncates to a whole percent', () => {
    expect(normalizeCommissionPercent(20.9)).toBe(20);
    expect(normalizeCommissionPercent(-1)).toBe(0);
    expect(normalizeCommissionPercent(1_000)).toBe(100);
    expect(normalizeCommissionPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('settleChannelAmount', () => {
  it('splits gross into commission and net, exactly', () => {
    const s = settleChannelAmount(24_995, 30);
    expect(s).toEqual({ grossCents: 24_995, commissionCents: 7_499, netCents: 17_496 });
    expect(s.commissionCents + s.netCents).toBe(s.grossCents);
  });

  it('prefers the partner’s stated commission over our configured percent', () => {
    // We think 30%; the remittance statement says 7000. The statement is the money.
    const s = settleChannelAmount(24_995, 30, 7_000);
    expect(s.commissionCents).toBe(7_000);
    expect(s.netCents).toBe(17_995);
  });

  it('clamps an absurd stated commission to the gross', () => {
    expect(settleChannelAmount(10_000, 20, 99_999).commissionCents).toBe(10_000);
    expect(settleChannelAmount(10_000, 20, 99_999).netCents).toBe(0);
  });

  it('falls back to the percent for a negative or fractional stated figure', () => {
    expect(settleChannelAmount(10_000, 20, -5).commissionCents).toBe(2_000);
    expect(settleChannelAmount(10_000, 20, 12.5).commissionCents).toBe(2_000);
  });

  it('treats a stated zero as a real zero, not as "unstated"', () => {
    // A partner waiving commission on a booking must not silently re-apply 20%.
    expect(settleChannelAmount(10_000, 20, 0).commissionCents).toBe(0);
    expect(settleChannelAmount(10_000, 20, 0).netCents).toBe(10_000);
  });

  it('holds gross = commission + net across a fuzz of amounts and rates', () => {
    for (let gross = 1; gross < 5_000; gross += 37) {
      for (const pct of [0, 1, 7, 12, 15, 20, 25, 30, 33, 50, 100]) {
        const s = settleChannelAmount(gross, pct);
        expect(s.commissionCents + s.netCents).toBe(gross);
        expect(Number.isInteger(s.commissionCents)).toBe(true);
      }
    }
  });
});

describe('summarizeChannelBookings', () => {
  const row = (over: Partial<SummarizableBooking> = {}): SummarizableBooking => ({
    channelId: 'ch_viator',
    channelName: 'Viator',
    kind: 'MOCK',
    grossCents: 10_000,
    commissionCents: 2_000,
    cancelled: false,
    ...over,
  });

  it('rolls bookings up per channel with exact integer sums', () => {
    const s = summarizeChannelBookings([
      row(),
      row({ grossCents: 24_995, commissionCents: 7_499 }),
      row({ channelId: 'ch_gyg', channelName: 'GetYourGuide', grossCents: 5_000, commissionCents: 1_250 }),
    ]);
    const viator = s.channels.find((c) => c.channelId === 'ch_viator')!;
    expect(viator.bookings).toBe(2);
    expect(viator.grossCents).toBe(34_995);
    expect(viator.commissionCents).toBe(9_499);
    expect(viator.netCents).toBe(25_496);
    expect(s.totals.grossCents).toBe(39_995);
    expect(s.totals.commissionCents).toBe(10_749);
    expect(s.totals.netCents).toBe(29_246);
  });

  it('counts a cancelled booking but takes its money out of every total', () => {
    const s = summarizeChannelBookings([row(), row({ cancelled: true, grossCents: 50_000 })]);
    expect(s.totals.bookings).toBe(2);
    expect(s.totals.cancelled).toBe(1);
    expect(s.totals.grossCents).toBe(10_000);
    expect(s.totals.commissionCents).toBe(2_000);
  });

  it('adds the snapshots instead of recomputing from a percent', () => {
    // Two bookings whose per-booking commission each rounded UP. Recomputing 25%
    // of the combined 20 cents would give 5; the snapshots say 6, and 6 is what
    // the partner actually kept.
    const s = summarizeChannelBookings([
      row({ grossCents: 10, commissionCents: commissionCents(10, 25) }),
      row({ grossCents: 10, commissionCents: commissionCents(10, 25) }),
    ]);
    expect(s.totals.commissionCents).toBe(6);
    expect(commissionCents(20, 25)).toBe(5);
  });

  it('orders channels by gross, biggest first, and totals to the parts', () => {
    const s = summarizeChannelBookings([
      row({ channelId: 'small', grossCents: 100, commissionCents: 10 }),
      row({ channelId: 'big', grossCents: 90_000, commissionCents: 9_000 }),
    ]);
    expect(s.channels.map((c) => c.channelId)).toEqual(['big', 'small']);
    expect(s.totals.grossCents).toBe(s.channels.reduce((n, c) => n + c.grossCents, 0));
  });

  it('is empty, not undefined, with no bookings', () => {
    const s = summarizeChannelBookings([]);
    expect(s.channels).toEqual([]);
    expect(s.totals).toEqual({ bookings: 0, cancelled: 0, grossCents: 0, commissionCents: 0, netCents: 0 });
  });
});

// ===========================================================================
// Published retail price
// ===========================================================================

describe('retailSchedule', () => {
  it('publishes the all-in price, not the pre-fee base', () => {
    const s = retailSchedule(10_000, [{ name: 'Sales Tax', type: 'PERCENT', value: 8.5 }]);
    expect(s.firstCents).toBe(10_850);
    expect(s.additionalCents).toBe(10_850);
  });

  it('charges a flat per-booking fee once, not once per traveller', () => {
    const s = retailSchedule(10_000, [{ name: 'Dock Fee', type: 'FLAT', value: 500 }]);
    expect(s.firstCents).toBe(10_500);
    expect(s.additionalCents).toBe(10_000);
    // A party of three costs base*3 + one dock fee.
    expect(s.firstCents + 2 * s.additionalCents).toBe(30_500);
  });

  it('passes a bare rate through untouched', () => {
    expect(retailSchedule(7_500, [])).toEqual({ firstCents: 7_500, additionalCents: 7_500 });
  });
});

describe('retailQuote', () => {
  const rate = { rateId: 'r1', name: 'Half day', retailPriceCents: 10_500, retailIncrementCents: 10_000 };

  it('quotes first-traveller plus each additional', () => {
    expect(retailQuote(rate, 1)).toBe(10_500);
    expect(retailQuote(rate, 3)).toBe(30_500);
  });

  it('never quotes less than a party of one', () => {
    expect(retailQuote(rate, 0)).toBe(10_500);
    expect(retailQuote(rate, -4)).toBe(10_500);
  });
});

// ===========================================================================
// Mock marketplace
// ===========================================================================

const NOW = new Date('2026-08-26T17:00:00.000Z');
const LATER = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

function listing(over: Partial<InventoryListing> = {}): InventoryListing {
  return {
    listingId: 'lst_1',
    activityId: 'act_1',
    externalRef: null,
    name: 'Pontoon Half Day',
    descriptionHtml: null,
    minParticipants: 1,
    maxParticipants: 8,
    rates: [
      {
        rateId: 'rate_1',
        name: 'Half day',
        priceCents: 10_000,
        retailPriceCents: 10_850,
        retailIncrementCents: 10_850,
        durationMinutes: 240,
      },
    ],
    slots: [
      { timeslotId: 'slot_1', startsAtIso: LATER(24).toISOString(), remaining: 6 },
      { timeslotId: 'slot_2', startsAtIso: LATER(48).toISOString(), remaining: 4 },
    ],
    ...over,
  };
}

function pushed(state: MockChannelState = mockInitialState(42)): MockChannelState {
  return applyPush(state, [listing()], NOW).state;
}

const CONFIG = mockChannelConfig({ arrivalIntervalMinutes: 60, cancellationEveryNth: 0, seed: 42 });

describe('deterministic randomness', () => {
  it('never collapses to zero', () => {
    let seed = 0;
    for (let i = 0; i < 200; i += 1) {
      seed = xorshift32(seed);
      expect(seed).not.toBe(0);
    }
  });

  it('stays inside an inclusive range', () => {
    let seed = 7;
    for (let i = 0; i < 500; i += 1) {
      const d = drawInt(seed, 2, 5);
      seed = d.seed;
      expect(d.value).toBeGreaterThanOrEqual(2);
      expect(d.value).toBeLessThanOrEqual(5);
    }
  });

  it('collapses a degenerate range to its single value', () => {
    expect(drawInt(99, 3, 3).value).toBe(3);
    expect(drawInt(99, 5, 1).value).toBe(5);
  });
});

describe('applyPush', () => {
  it('accepts a listing and assigns it a partner reference', () => {
    const out = applyPush(mockInitialState(42), [listing()], NOW);
    expect(out.result.accepted).toHaveLength(1);
    expect(out.result.accepted[0]!.externalRef).toMatch(/^MOCK-LST-/);
    expect(out.state.listings[0]!.slots).toHaveLength(2);
  });

  it('keeps the same reference across a republish so the product is not duplicated', () => {
    const first = applyPush(mockInitialState(42), [listing()], NOW);
    const ref = first.result.accepted[0]!.externalRef;
    const second = applyPush(first.state, [listing()], LATER(1));
    expect(second.result.accepted[0]!.externalRef).toBe(ref);
    expect(second.state.listings).toHaveLength(1);
  });

  it('refuses a product with no price and one with no availability', () => {
    const out = applyPush(
      mockInitialState(42),
      [
        listing({ listingId: 'no_rate', rates: [] }),
        listing({ listingId: 'no_slots', slots: [] }),
      ],
      NOW,
    );
    expect(out.result.accepted).toHaveLength(0);
    expect(out.result.rejected.map((r) => r.listingId).sort()).toEqual(['no_rate', 'no_slots']);
  });

  it('replaces the snapshot wholesale — a withdrawn product stops being sellable', () => {
    const state = pushed();
    const after = applyPush(state, [], LATER(1));
    expect(after.state.listings).toHaveLength(0);
    expect(queueBooking(after.state, LATER(2), CONFIG).booking).toBeNull();
  });
});

describe('queueBooking', () => {
  it('sells only what was pushed', () => {
    const out = queueBooking(mockInitialState(42), NOW, CONFIG);
    expect(out.booking).toBeNull();
    expect(out.reason).toMatch(/push first/i);
  });

  it('produces a booking against a pushed rate and departure', () => {
    const out = queueBooking(pushed(), NOW, CONFIG);
    const b = out.booking!;
    expect(b.externalRef).toMatch(/^MOCK-BKG-/);
    expect(b.rateId).toBe('rate_1');
    expect(['slot_1', 'slot_2']).toContain(b.timeslotId);
    expect(b.quantity).toBeGreaterThanOrEqual(1);
    expect(b.grossCents).toBe(retailQuote(pushed().listings[0]!.rates[0]!, b.quantity));
    expect(Number.isInteger(b.grossCents)).toBe(true);
  });

  it('queues exactly one unacknowledged notice per booking', () => {
    const out = queueBooking(pushed(), NOW, CONFIG);
    expect(out.state.outbox).toHaveLength(1);
    expect(out.state.outbox[0]!).toMatchObject({
      externalRef: out.booking!.externalRef,
      status: 'CONFIRMED',
      acknowledged: false,
      deliveries: 0,
    });
  });

  it('is deterministic for a given seed', () => {
    const a = queueBooking(pushed(mockInitialState(7)), NOW, CONFIG).booking!;
    const b = queueBooking(pushed(mockInitialState(7)), NOW, CONFIG).booking!;
    expect(a).toEqual(b);
  });

  it('gives two guests booked in a row distinct customer records', () => {
    const first = queueBooking(pushed(), NOW, CONFIG);
    const second = queueBooking(first.state, NOW, CONFIG);
    expect(second.booking!.customer.email).not.toBe(first.booking!.customer.email);
    expect(second.booking!.externalRef).not.toBe(first.booking!.externalRef);
  });

  it('will not sell a departure that has already left', () => {
    const state = pushed();
    // Both published slots are in the past by now.
    expect(queueBooking(state, LATER(72), CONFIG).booking).toBeNull();
  });

  it('honours an explicit slot, rate and party size', () => {
    const out = queueBooking(pushed(), NOW, CONFIG, {
      timeslotId: 'slot_2',
      rateId: 'rate_1',
      quantity: 3,
    });
    expect(out.booking).toMatchObject({ timeslotId: 'slot_2', rateId: 'rate_1', quantity: 3 });
    expect(out.booking!.grossCents).toBe(10_850 * 3);
  });

  it('reports a rate or departure it was never told about', () => {
    expect(queueBooking(pushed(), NOW, CONFIG, { rateId: 'nope' }).reason).toMatch(/no such rate/i);
    expect(queueBooking(pushed(), NOW, CONFIG, { timeslotId: 'nope' }).reason).toMatch(/no such departure/i);
  });

  it('decrements its own snapshot so it does not resell the same seat', () => {
    let state = pushed();
    let sold = 0;
    for (let i = 0; i < 20; i += 1) {
      const out = queueBooking(state, NOW, CONFIG, { timeslotId: 'slot_1' });
      if (!out.booking) break;
      state = out.state;
      sold += out.booking.quantity;
    }
    expect(sold).toBe(6); // exactly the 6 seats it was told about
    const slot = state.listings[0]!.slots.find((s) => s.timeslotId === 'slot_1')!;
    expect(slot.remaining).toBe(0);
  });

  it('will not offer a departure too small for the product’s minimum party', () => {
    const tight = applyPush(
      mockInitialState(42),
      [
        listing({
          minParticipants: 4,
          slots: [{ timeslotId: 'slot_tiny', startsAtIso: LATER(24).toISOString(), remaining: 2 }],
        }),
      ],
      NOW,
    ).state;
    expect(queueBooking(tight, NOW, CONFIG).booking).toBeNull();
  });

  it('keeps the party size inside the product’s own min and max', () => {
    const banded = applyPush(
      mockInitialState(3),
      [listing({ minParticipants: 2, maxParticipants: 3 })],
      NOW,
    ).state;
    let state = banded;
    for (let i = 0; i < 5; i += 1) {
      const out = queueBooking(state, NOW, CONFIG);
      if (!out.booking) break;
      expect(out.booking.quantity).toBeGreaterThanOrEqual(2);
      expect(out.booking.quantity).toBeLessThanOrEqual(3);
      state = out.state;
    }
  });

  it('WILL oversell on demand — the marketplace is not what protects the boat', () => {
    const out = queueBooking(pushed(), NOW, CONFIG, { timeslotId: 'slot_1', oversell: true });
    // The snapshot said 6 free; it sells 7 and is perfectly happy about it.
    expect(out.booking!.quantity).toBe(7);
    expect(out.state.listings[0]!.slots.find((s) => s.timeslotId === 'slot_1')!.remaining).toBe(0);
  });
});

describe('delivery and acknowledgement', () => {
  it('redelivers an unacknowledged notice on every pull', () => {
    const state = queueBooking(pushed(), NOW, CONFIG).state;
    const first = pendingNotices(state, 10, null);
    expect(first).toHaveLength(1);

    const afterOne = markDelivered(state, [first[0]!.id]);
    const second = pendingNotices(afterOne, 10, null);
    expect(second).toHaveLength(1);
    expect(second[0]!.deliveries).toBe(1);
  });

  it('stops redelivering once acknowledged', () => {
    const state = queueBooking(pushed(), NOW, CONFIG).state;
    const notices = pendingNotices(state, 10, null);
    const delivered = markDelivered(state, notices.map((n) => n.id));
    const acked = acknowledgeNotices(delivered, notices.map((n) => n.externalRef));
    expect(pendingNotices(acked, 10, null)).toHaveLength(0);
  });

  it('ignores an acknowledgement for a notice it has not shown us yet', () => {
    // Guards against acking a cancellation that is still queued behind the confirm.
    const state = queueBooking(pushed(), NOW, CONFIG);
    const acked = acknowledgeNotices(state.state, [state.booking!.externalRef]);
    expect(pendingNotices(acked, 10, null)).toHaveLength(1);
  });

  it('honours the pull limit and hands the oldest over first', () => {
    let state = pushed();
    for (let i = 0; i < 3; i += 1) state = queueBooking(state, NOW, CONFIG).state;
    const page = pendingNotices(state, 2, null);
    expect(page).toHaveLength(2);
    expect(page[0]!.id).toBe(state.outbox[0]!.id);
  });

  it('filters by the caller’s since watermark', () => {
    const first = queueBooking(pushed(), NOW, CONFIG);
    const second = queueBooking(first.state, LATER(5), CONFIG);
    expect(pendingNotices(second.state, 10, LATER(1))).toHaveLength(1);
  });
});

describe('advanceArrivals', () => {
  it('produces one arrival on the very first pull rather than making you wait', () => {
    const out = advanceArrivals(pushed(), NOW, CONFIG);
    expect(out.created).toBe(1);
    expect(out.state.lastArrivalAtIso).toBe(NOW.toISOString());
  });

  it('produces nothing again until an interval of clock has passed', () => {
    const first = advanceArrivals(pushed(), NOW, CONFIG);
    const immediately = advanceArrivals(first.state, NOW, CONFIG);
    expect(immediately.created).toBe(0);
    const anHourLater = advanceArrivals(first.state, LATER(1), CONFIG);
    expect(anHourLater.created).toBe(1);
  });

  it('turns a clock jump into that many arrivals', () => {
    // The Local Console jumps 5 hours; a 60-minute cadence owes 5 bookings.
    const first = advanceArrivals(pushed(), NOW, CONFIG);
    const jumped = advanceArrivals(first.state, LATER(5), CONFIG);
    expect(jumped.created).toBe(5);
  });

  it('caps a huge jump and keeps the remainder owed instead of swallowing it', () => {
    const capped = mockChannelConfig({ arrivalIntervalMinutes: 60, maxArrivalsPerPull: 2, cancellationEveryNth: 0 });
    const first = advanceArrivals(pushed(), NOW, capped);
    const jumped = advanceArrivals(first.state, LATER(10), capped);
    expect(jumped.created).toBe(2);
    // The clock advanced by the 2 intervals actually consumed, not to `now`.
    expect(jumped.state.lastArrivalAtIso).toBe(LATER(2).toISOString());
    expect(advanceArrivals(jumped.state, LATER(10), capped).created).toBe(2);
  });

  it('stops burning the schedule when there is nothing left to sell', () => {
    const out = advanceArrivals(mockInitialState(42), NOW, CONFIG);
    expect(out.created).toBe(0);
    expect(out.cancelled).toBe(0);
  });

  it('mixes guest cancellations into the arrivals once there is something to cancel', () => {
    const cadence = mockChannelConfig({ arrivalIntervalMinutes: 60, cancellationEveryNth: 2, seed: 42 });
    // Sell, deliver and acknowledge one booking so the partner believes we have it.
    const sold = queueBooking(pushed(), NOW, cadence);
    const notices = pendingNotices(sold.state, 10, null);
    const acked = acknowledgeNotices(markDelivered(sold.state, notices.map((n) => n.id)), [
      sold.booking!.externalRef,
    ]);

    const run = advanceArrivals({ ...acked, lastArrivalAtIso: NOW.toISOString() }, LATER(1), cadence);
    expect(run.cancelled).toBe(1);
    expect(run.created).toBe(0);
    const notice = run.state.outbox.at(-1)!;
    expect(notice.status).toBe('CANCELLED');
    expect(notice.externalRef).toBe(sold.booking!.externalRef);
  });

  it('sells instead when a cancellation is due but nothing is cancellable', () => {
    const cadence = mockChannelConfig({ arrivalIntervalMinutes: 60, cancellationEveryNth: 1, seed: 42 });
    const out = advanceArrivals(pushed(), NOW, cadence);
    expect(out.cancelled).toBe(0);
    expect(out.created).toBe(1);
  });
});

describe('queueGuestCancellation', () => {
  function soldAndAcked() {
    const sold = queueBooking(pushed(), NOW, CONFIG);
    const notices = pendingNotices(sold.state, 10, null);
    return {
      ref: sold.booking!.externalRef,
      state: acknowledgeNotices(markDelivered(sold.state, notices.map((n) => n.id)), [
        sold.booking!.externalRef,
      ]),
    };
  }

  it('cancels an acknowledged booking and queues the notice', () => {
    const { ref, state } = soldAndAcked();
    const out = queueGuestCancellation(state, LATER(2), ref);
    expect(out.externalRef).toBe(ref);
    expect(out.state.bookings[0]!.status).toBe('CANCELLED');
    expect(pendingNotices(out.state, 10, null)).toHaveLength(1);
  });

  it('will not cancel a booking the partner does not believe we received', () => {
    // Sold but never acknowledged: cancelling it would be a cancellation for a
    // booking we have not imported, which is a different code path entirely.
    const sold = queueBooking(pushed(), NOW, CONFIG);
    const out = queueGuestCancellation(sold.state, LATER(2));
    expect(out.externalRef).toBeNull();
    expect(out.reason).toMatch(/pull the confirmed bookings first/i);
  });

  it('refuses to cancel the same booking twice', () => {
    const { ref, state } = soldAndAcked();
    const once = queueGuestCancellation(state, LATER(2), ref);
    const twice = queueGuestCancellation(once.state, LATER(3), ref);
    expect(twice.externalRef).toBeNull();
  });
});

describe('applySupplierCancel', () => {
  it('accepts an operator cancellation and charges the configured penalty', () => {
    const config = mockChannelConfig({ cancellationPenaltyCents: 2_500 });
    const sold = queueBooking(pushed(), NOW, config);
    const out = applySupplierCancel(sold.state, sold.booking!.externalRef, LATER(1), config);
    expect(out.result).toMatchObject({ accepted: true, penaltyCents: 2_500 });
    expect(out.state.bookings[0]!.status).toBe('CANCELLED');
  });

  it('does not queue an inbound notice — we already know we cancelled', () => {
    const sold = queueBooking(pushed(), NOW, CONFIG);
    const before = sold.state.outbox.length;
    const out = applySupplierCancel(sold.state, sold.booking!.externalRef, LATER(1), CONFIG);
    expect(out.state.outbox).toHaveLength(before);
  });

  it('is idempotent: a retried cancellation is not a second penalty', () => {
    const config = mockChannelConfig({ cancellationPenaltyCents: 2_500 });
    const sold = queueBooking(pushed(), NOW, config);
    const once = applySupplierCancel(sold.state, sold.booking!.externalRef, LATER(1), config);
    const twice = applySupplierCancel(once.state, sold.booking!.externalRef, LATER(2), config);
    expect(twice.result).toMatchObject({ accepted: true, penaltyCents: 0 });
  });

  it('refuses a reference it has never heard of', () => {
    const out = applySupplierCancel(pushed(), 'MOCK-BKG-999', NOW, CONFIG);
    expect(out.result.accepted).toBe(false);
    expect(out.result.reason).toMatch(/unknown/i);
  });
});

describe('toPayload', () => {
  it('normalizes a stored booking into the import payload, keeping the raw record', () => {
    const sold = queueBooking(pushed(), NOW, CONFIG);
    const notice = sold.state.outbox[0]!;
    const payload = toPayload(sold.booking!, notice, 'Mock Marketplace');

    expect(payload).toMatchObject({
      externalRef: sold.booking!.externalRef,
      status: 'CONFIRMED',
      rateId: 'rate_1',
      // No stated commission: the channel's configured percent applies at import.
      commissionCents: null,
      prepaid: true,
    });
    expect(payload.raw).toMatchObject({
      source: 'Mock Marketplace',
      notificationId: notice.id,
      deliveryAttempt: 1,
      currency: 'USD',
    });
    // The payload must survive the JSON round-trip Prisma does on `raw`.
    expect(JSON.parse(JSON.stringify(payload.raw))).toEqual(payload.raw);
  });

  it('carries the delivery attempt so a redelivery is visible in the audit trail', () => {
    const sold = queueBooking(pushed(), NOW, CONFIG);
    const redelivered = markDelivered(sold.state, [sold.state.outbox[0]!.id]);
    const payload = toPayload(sold.booking!, redelivered.outbox[0]!, 'Mock Marketplace');
    expect(payload.raw.deliveryAttempt).toBe(2);
  });
});

describe('state persistence', () => {
  it('survives the JSON round-trip through Channel.config', () => {
    const state = queueBooking(pushed(), NOW, CONFIG).state;
    const restored = toMockState(JSON.parse(JSON.stringify(state)));
    expect(restored).toEqual(state);
  });

  it('falls back to a fresh marketplace for junk, a null, or an old version', () => {
    expect(toMockState(null, 9).seed).toBe(9);
    expect(toMockState('nonsense', 9).listings).toEqual([]);
    expect(toMockState({ version: 0, listings: [{}] }, 9)).toEqual(mockInitialState(9));
  });
});

describe('mockChannelConfig', () => {
  it('defaults every knob and clamps nonsense into range', () => {
    const c = mockChannelConfig({});
    expect(c.arrivalIntervalMinutes).toBe(240);
    expect(c.prepaid).toBe(true);

    const clamped = mockChannelConfig({
      arrivalIntervalMinutes: 0,
      maxArrivalsPerPull: 10_000,
      cancellationPenaltyCents: -1,
      prepaid: 'yes',
    });
    expect(clamped.arrivalIntervalMinutes).toBe(1);
    expect(clamped.maxArrivalsPerPull).toBe(100);
    expect(clamped.cancellationPenaltyCents).toBe(0);
    expect(clamped.prepaid).toBe(true); // non-boolean falls back to the default
  });
});
