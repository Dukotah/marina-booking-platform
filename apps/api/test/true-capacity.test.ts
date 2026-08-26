/**
 * True capacity — pure unit tests for the intersection the availability service does
 * between a timeslot's own capacity and what the shared resource pools (D-014) can
 * still honour in that slot's window. No DB, no network.
 *
 * The point of the feature is that availability NEVER LIES: if a boat is already out
 * on a different activity, the calendar has to say so up front rather than at
 * checkout. These tests pin (a) the window arithmetic — which must agree exactly with
 * the half-open overlap `reservedSeats` enforces in SQL — and (b) the min-across-pools
 * rule with the reason the UI shows.
 */
import { describe, it, expect } from 'vitest';
import {
  buildPoolLedger,
  resolveTrueCapacity,
  seatsReservedIn,
  type PoolLedger,
  type ResourceReservation,
} from '../src/services/availability.js';

const HOUR = 3_600_000;
/** Arbitrary fixed base instant; only relative offsets matter. */
const T0 = Date.UTC(2026, 6, 4, 16, 0, 0);
const at = (hours: number) => T0 + hours * HOUR;

/** A reservation spanning [from, to) hours from the base instant. */
const res = (from: number, to: number, seats: number): ResourceReservation => ({
  startsAt: at(from),
  endsAt: at(to),
  seats,
});

function ledger(totalSeats: number, reservations: ResourceReservation[], name = 'Pontoons'): PoolLedger {
  return buildPoolLedger({ id: `pool-${name}`, name, totalSeats }, reservations);
}

describe('seatsReservedIn — half-open window overlap', () => {
  it('is zero for a pool with no reservations', () => {
    expect(seatsReservedIn(ledger(4, []), at(0), at(1))).toBe(0);
  });

  it('counts a reservation that sits inside the window', () => {
    expect(seatsReservedIn(ledger(4, [res(0.25, 0.75, 2)]), at(0), at(1))).toBe(2);
  });

  it('counts a reservation that fully contains the window', () => {
    expect(seatsReservedIn(ledger(4, [res(-2, 5, 3)]), at(0), at(1))).toBe(3);
  });

  it('counts partial overlaps on either edge', () => {
    expect(seatsReservedIn(ledger(4, [res(-1, 0.5, 1)]), at(0), at(1))).toBe(1);
    expect(seatsReservedIn(ledger(4, [res(0.5, 2, 1)]), at(0), at(1))).toBe(1);
  });

  it('ignores a reservation that merely abuts the window (ends exactly at the start)', () => {
    expect(seatsReservedIn(ledger(4, [res(-1, 0, 2)]), at(0), at(1))).toBe(0);
  });

  it('ignores a reservation that starts exactly when the window ends', () => {
    expect(seatsReservedIn(ledger(4, [res(1, 2, 2)]), at(0), at(1))).toBe(0);
  });

  it('sums every overlapping reservation, not just the first', () => {
    const l = ledger(10, [res(0, 1, 1), res(0.5, 1.5, 2), res(-1, 0.25, 4), res(3, 4, 8)]);
    expect(seatsReservedIn(l, at(0), at(1))).toBe(7); // 1 + 2 + 4; the 3-4h one is elsewhere
  });

  it('treats a zero-length window as "spanning this instant" (activity with no rate duration)', () => {
    const l = ledger(4, [res(0, 2, 2)]);
    expect(seatsReservedIn(l, at(1), at(1))).toBe(2); // instant inside the reservation
    expect(seatsReservedIn(l, at(2), at(2))).toBe(0); // instant at its exclusive end
    // At the reservation's own start the empty window is still empty — `start < end`
    // fails. Odd, but it is exactly what the SQL overlap does, and matching the
    // booking-time check matters more than the philosophy of a zero-length window.
    expect(seatsReservedIn(l, at(0), at(0))).toBe(0);
  });

  it('is order-independent: reservations may arrive from the DB in any order', () => {
    const rs = [res(2, 3, 1), res(-1, 0.5, 2), res(0.75, 5, 3)];
    const forward = seatsReservedIn(ledger(9, rs), at(0), at(1));
    const backward = seatsReservedIn(ledger(9, [...rs].reverse()), at(0), at(1));
    expect(forward).toBe(5);
    expect(backward).toBe(5);
  });

  it('matches a naive scan across randomised reservations and windows', () => {
    // The prefix-sum identity (started-before-end minus ended-at-or-before-start) is
    // the whole reason a month view is not N+1 queries, so prove it the boring way.
    // Lehmer PRNG: deterministic, and its products stay inside the safe-integer range.
    let seed = 1337;
    const rand = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const reservations: ResourceReservation[] = [];
    for (let i = 0; i < 60; i += 1) {
      const start = Math.floor(rand() * 48);
      const span = 1 + Math.floor(rand() * 6);
      reservations.push(res(start, start + span, 1 + Math.floor(rand() * 3)));
    }
    const l = ledger(100, reservations);

    for (let i = 0; i < 300; i += 1) {
      const wStart = Math.floor(rand() * 52) - 2;
      const wEnd = wStart + Math.floor(rand() * 5); // includes zero-length windows
      const naive = reservations
        .filter((r) => r.startsAt < at(wEnd) && r.endsAt > at(wStart))
        .reduce((n, r) => n + r.seats, 0);
      expect(seatsReservedIn(l, at(wStart), at(wEnd))).toBe(naive);
    }
  });
});

describe('resolveTrueCapacity — no shared resources', () => {
  it('passes the timeslot numbers straight through', () => {
    const c = resolveTrueCapacity({
      capacityTotal: 10,
      capacityBooked: 4,
      pools: [],
      startsAt: at(0),
      endsAt: at(1),
    });
    expect(c).toEqual({
      capacityBooked: 4,
      capacityRemaining: 6,
      status: 'AVAILABLE',
      available: true,
      limitedBy: null,
      unavailableReason: null,
    });
  });

  it('reports a plainly full slot without inventing a resource excuse', () => {
    const c = resolveTrueCapacity({
      capacityTotal: 6,
      capacityBooked: 6,
      pools: [],
      startsAt: at(0),
      endsAt: at(1),
    });
    expect(c.available).toBe(false);
    expect(c.status).toBe('FULL');
    expect(c.limitedBy).toBeNull();
    expect(c.unavailableReason).toBe('Fully booked');
  });

  it('keeps the real booked count on an already-overbooked slot', () => {
    const c = resolveTrueCapacity({
      capacityTotal: 10,
      capacityBooked: 12,
      pools: [],
      startsAt: at(0),
      endsAt: at(1),
    });
    expect(c.capacityBooked).toBe(12); // staff must still see the overbooking
    expect(c.capacityRemaining).toBe(0);
    expect(c.status).toBe('FULL');
  });

  it('treats a slot with no capacity to sell as full', () => {
    const c = resolveTrueCapacity({
      capacityTotal: 0,
      capacityBooked: 0,
      pools: [],
      startsAt: at(0),
      endsAt: at(1),
    });
    expect(c.available).toBe(false);
    expect(c.capacityRemaining).toBe(0);
    expect(c.status).toBe('FULL');
  });
});

describe('resolveTrueCapacity — the shared boat is the constraint', () => {
  it('shows a slot as unavailable when the pool is committed to another activity', () => {
    // The D-014 scenario: this timeslot has 10 seats of its own, but both shared jet
    // skis are already out on a different activity for the same hour.
    const pool = ledger(2, [res(0, 1, 2)], 'Jet Skis');
    const c = resolveTrueCapacity({
      capacityTotal: 10,
      capacityBooked: 0,
      pools: [pool],
      startsAt: at(0),
      endsAt: at(1),
    });
    expect(c.capacityRemaining).toBe(0);
    expect(c.capacityBooked).toBe(10); // re-expressed so the status rule stays coherent
    expect(c.status).toBe('FULL');
    expect(c.available).toBe(false);
    expect(c.unavailableReason).toBe('Jet Skis already out');
    expect(c.limitedBy).toEqual({
      kind: 'RESOURCE',
      resourceId: 'pool-Jet Skis',
      resourceName: 'Jet Skis',
      remaining: 0,
      reason: 'Jet Skis already out',
    });
  });

  it('caps a partially-committed slot at what the pool can still honour', () => {
    const pool = ledger(6, [res(0.5, 1.5, 3)], 'Pontoons');
    const c = resolveTrueCapacity({
      capacityTotal: 10,
      capacityBooked: 0,
      pools: [pool],
      startsAt: at(0),
      endsAt: at(1),
    });
    expect(c.capacityRemaining).toBe(3);
    expect(c.capacityBooked).toBe(7);
    expect(c.status).toBe('FILLING_UP'); // 7/10 is the 70% threshold
    expect(c.available).toBe(true);
    expect(c.unavailableReason).toBeNull();
    expect(c.limitedBy?.remaining).toBe(3);
    expect(c.limitedBy?.reason).toBe('Only 3 left of Pontoons');
  });

  it('leaves the slot untouched when the pool is free at that time', () => {
    // Same pool, same day, a window the earlier booking does not overlap.
    const pool = ledger(6, [res(3, 4, 6)], 'Pontoons');
    const c = resolveTrueCapacity({
      capacityTotal: 4,
      capacityBooked: 1,
      pools: [pool],
      startsAt: at(0),
      endsAt: at(1),
    });
    expect(c.capacityRemaining).toBe(3);
    expect(c.limitedBy).toBeNull();
    expect(c.status).toBe('AVAILABLE');
  });

  it('blames the slot, not the pool, when the pool is merely as tight', () => {
    const pool = ledger(3, [], 'Pontoons');
    const c = resolveTrueCapacity({
      capacityTotal: 8,
      capacityBooked: 5, // slot itself has exactly 3 left
      pools: [pool],
      startsAt: at(0),
      endsAt: at(1),
    });
    expect(c.capacityRemaining).toBe(3);
    expect(c.limitedBy).toBeNull();
  });

  it('says a pool with every unit out of service is out of service, not "already out"', () => {
    const pool = ledger(0, [], 'Ski Boat');
    const c = resolveTrueCapacity({
      capacityTotal: 6,
      capacityBooked: 0,
      pools: [pool],
      startsAt: at(0),
      endsAt: at(1),
    });
    expect(c.available).toBe(false);
    expect(c.unavailableReason).toBe('Ski Boat is out of service');
  });

  it('never reports negative remaining when a pool is somehow oversold', () => {
    const pool = ledger(2, [res(0, 1, 5)], 'Kayaks');
    const c = resolveTrueCapacity({
      capacityTotal: 10,
      capacityBooked: 0,
      pools: [pool],
      startsAt: at(0),
      endsAt: at(1),
    });
    expect(c.capacityRemaining).toBe(0);
    expect(c.capacityBooked).toBe(10);
    expect(c.limitedBy?.remaining).toBe(0);
  });
});

describe('resolveTrueCapacity — several pools', () => {
  const guides = ledger(4, [res(0, 1, 1)], 'Guides'); // 3 free
  const boats = ledger(2, [res(0, 1, 1)], 'Ski Boats'); // 1 free

  it('takes the tightest pool and names it', () => {
    const c = resolveTrueCapacity({
      capacityTotal: 8,
      capacityBooked: 0,
      pools: [guides, boats],
      startsAt: at(0),
      endsAt: at(1),
    });
    expect(c.capacityRemaining).toBe(1);
    expect(c.limitedBy?.resourceName).toBe('Ski Boats');
  });

  it('is independent of the order the pools are supplied in', () => {
    const forward = resolveTrueCapacity({
      capacityTotal: 8,
      capacityBooked: 0,
      pools: [guides, boats],
      startsAt: at(0),
      endsAt: at(1),
    });
    const backward = resolveTrueCapacity({
      capacityTotal: 8,
      capacityBooked: 0,
      pools: [boats, guides],
      startsAt: at(0),
      endsAt: at(1),
    });
    expect(backward.capacityRemaining).toBe(forward.capacityRemaining);
    expect(backward.limitedBy?.resourceName).toBe(forward.limitedBy?.resourceName);
  });

  it('still blames the slot when the slot is tighter than every pool', () => {
    const c = resolveTrueCapacity({
      capacityTotal: 1,
      capacityBooked: 0,
      pools: [guides, boats],
      startsAt: at(0),
      endsAt: at(1),
    });
    expect(c.capacityRemaining).toBe(1);
    expect(c.limitedBy).toBeNull();
  });

  it('reports the first exhausted pool when more than one is out', () => {
    const outA = ledger(2, [res(0, 1, 2)], 'A Boats');
    const outB = ledger(2, [res(0, 1, 2)], 'B Boats');
    const c = resolveTrueCapacity({
      capacityTotal: 5,
      capacityBooked: 0,
      pools: [outA, outB],
      startsAt: at(0),
      endsAt: at(1),
    });
    expect(c.limitedBy?.resourceName).toBe('A Boats');
    expect(c.unavailableReason).toBe('A Boats already out');
  });
});

describe('resolveTrueCapacity — agreement with booking-time enforcement', () => {
  // The booking service refuses when `quantity > pool remaining`. Availability must
  // therefore never advertise more than that number, for any quantity a guest picks.
  it('advertises exactly the quantity the booking service would accept', () => {
    const pool = ledger(6, [res(0, 1, 4)], 'Pontoons'); // 2 seats free
    const c = resolveTrueCapacity({
      capacityTotal: 12,
      capacityBooked: 0,
      pools: [pool],
      startsAt: at(0),
      endsAt: at(1),
    });
    const wouldBeRefused = (qty: number) =>
      qty > pool.totalSeats - seatsReservedIn(pool, at(0), at(1));

    expect(c.capacityRemaining).toBe(2);
    expect(wouldBeRefused(c.capacityRemaining)).toBe(false);
    expect(wouldBeRefused(c.capacityRemaining + 1)).toBe(true);
  });
});
