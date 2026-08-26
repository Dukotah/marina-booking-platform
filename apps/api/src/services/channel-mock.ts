/**
 * MOCK channel driver — a whole OTA marketplace, running in this process.
 *
 * docs/LOCAL-FIRST-BUILD.md §8 requires the channel abstraction to ship with a
 * local mock so distribution is testable with no partner account, and §0's
 * corollary says a local driver must be a faithful simulation rather than a toy.
 * So this marketplace does what Viator and GetYourGuide actually do to a supplier:
 *
 *   - it accepts an inventory push and SELLS FROM THAT SNAPSHOT, which goes stale
 *     the moment anyone books through the website. That is how a channel oversells
 *     a boat, and it is the failure the import path has to survive;
 *   - it delivers AT LEAST ONCE. A booking we do not acknowledge comes back on the
 *     next pull, forever, which is what makes `external_ref` dedupe load-bearing;
 *   - bookings arrive on a SCHEDULE against the sandbox clock, so jumping the
 *     Local Console forward six hours produces six hours of arrivals;
 *   - guests cancel, and the cancellation arrives the same way a booking does;
 *   - it can refuse. `failNextPush` / `failNextPull` make a partner outage a thing
 *     the owner can produce on demand instead of waiting for one.
 *
 * Everything here is a PURE function over a plain-JSON state object plus a thin
 * driver wrapper that loads and saves that state. The state lives in
 * `Channel.config.driver`, so the marketplace survives a restart with no table of
 * its own — and the pure core is unit-testable with no database at all.
 *
 * Randomness is a seeded xorshift carried in the state: the same seed and the
 * same sequence of calls always produce the same marketplace. An owner
 * demonstrating a bug can hand over the seed and get the same bookings back.
 */
import type {
  ChannelBookingPayload,
  ChannelCancelResult,
  ChannelDriver,
  ChannelDriverContext,
  InventoryListing,
  PullBookingsResult,
  PushInventoryResult,
} from './channels.js';

// ===========================================================================
// Configuration
// ===========================================================================

/** Knobs an owner can set in `Channel.config`; every one has a sane default. */
export interface MockChannelConfig {
  /** Minutes of (sandbox) time between simulated arrivals. */
  arrivalIntervalMinutes: number;
  /** Ceiling on arrivals manufactured by one pull, so a clock jump can't flood. */
  maxArrivalsPerPull: number;
  /** Every Nth arrival is a guest cancellation instead of a new booking. 0 = never. */
  cancellationEveryNth: number;
  /** True when the marketplace collects the guest's money (an OTA) rather than referring. */
  prepaid: boolean;
  /** What the partner charges the operator for an operator-initiated cancellation. */
  cancellationPenaltyCents: number;
  /** Largest party the marketplace will sell in one booking. */
  maxPartySize: number;
  seed: number;
}

const DEFAULTS: MockChannelConfig = {
  arrivalIntervalMinutes: 240,
  maxArrivalsPerPull: 10,
  cancellationEveryNth: 7,
  prepaid: true,
  cancellationPenaltyCents: 0,
  maxPartySize: 4,
  seed: 1_337,
};

function intOr(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function mockChannelConfig(raw: Record<string, unknown>): MockChannelConfig {
  return {
    arrivalIntervalMinutes: intOr(raw.arrivalIntervalMinutes, DEFAULTS.arrivalIntervalMinutes, 1, 43_200),
    maxArrivalsPerPull: intOr(raw.maxArrivalsPerPull, DEFAULTS.maxArrivalsPerPull, 1, 100),
    cancellationEveryNth: intOr(raw.cancellationEveryNth, DEFAULTS.cancellationEveryNth, 0, 1_000),
    prepaid: typeof raw.prepaid === 'boolean' ? raw.prepaid : DEFAULTS.prepaid,
    cancellationPenaltyCents: intOr(raw.cancellationPenaltyCents, DEFAULTS.cancellationPenaltyCents, 0, 1_000_000),
    maxPartySize: intOr(raw.maxPartySize, DEFAULTS.maxPartySize, 1, 100),
    seed: intOr(raw.seed, DEFAULTS.seed, 1, 2_147_483_647),
  };
}

// ===========================================================================
// State
// ===========================================================================

/** A rate exactly as the marketplace was told about it. */
export interface MockRateSnapshot {
  rateId: string;
  name: string;
  /** All-in price for one traveller, integer cents. */
  retailPriceCents: number;
  /** All-in price of each additional traveller, integer cents. */
  retailIncrementCents: number;
}

export interface MockSlotSnapshot {
  timeslotId: string;
  startsAtIso: string;
  /** Seats free WHEN WE WERE TOLD. Deliberately never refreshed between pushes. */
  remaining: number;
}

export interface MockListingSnapshot {
  externalRef: string;
  listingId: string;
  activityId: string;
  name: string;
  minParticipants: number;
  maxParticipants: number;
  rates: MockRateSnapshot[];
  slots: MockSlotSnapshot[];
  pushedAtIso: string;
}

export interface MockBookingRecord {
  externalRef: string;
  listingExternalRef: string;
  rateId: string;
  timeslotId: string;
  quantity: number;
  grossCents: number;
  prepaid: boolean;
  status: 'CONFIRMED' | 'CANCELLED';
  customer: { firstName: string; lastName: string; email: string; phone: string };
  leadTravellerName: string;
  bookedAtIso: string;
  cancelledAtIso: string | null;
}

/** One outbound notification. Redelivered until acknowledged. */
export interface MockNotice {
  id: string;
  externalRef: string;
  status: 'CONFIRMED' | 'CANCELLED';
  queuedAtIso: string;
  deliveries: number;
  acknowledged: boolean;
}

export interface MockChannelState {
  version: 1;
  seed: number;
  /** Monotonic counter behind every generated reference. */
  sequence: number;
  listings: MockListingSnapshot[];
  bookings: MockBookingRecord[];
  outbox: MockNotice[];
  lastArrivalAtIso: string | null;
  /** Set to an error message to make the NEXT push fail, then cleared. */
  failNextPush: string | null;
  /** Set to an error message to make the NEXT pull fail, then cleared. */
  failNextPull: string | null;
}

export function mockInitialState(seed: number = DEFAULTS.seed): MockChannelState {
  return {
    version: 1,
    seed,
    sequence: 0,
    listings: [],
    bookings: [],
    outbox: [],
    lastArrivalAtIso: null,
    failNextPush: null,
    failNextPull: null,
  };
}

/** Coerce whatever is in `Channel.config.driver` into a usable state. */
export function toMockState(raw: unknown, seed: number = DEFAULTS.seed): MockChannelState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return mockInitialState(seed);
  const r = raw as Partial<MockChannelState>;
  if (r.version !== 1) return mockInitialState(seed);
  return {
    version: 1,
    seed: typeof r.seed === 'number' && Number.isFinite(r.seed) ? r.seed : seed,
    sequence: typeof r.sequence === 'number' ? Math.max(0, Math.trunc(r.sequence)) : 0,
    listings: Array.isArray(r.listings) ? r.listings : [],
    bookings: Array.isArray(r.bookings) ? r.bookings : [],
    outbox: Array.isArray(r.outbox) ? r.outbox : [],
    lastArrivalAtIso: typeof r.lastArrivalAtIso === 'string' ? r.lastArrivalAtIso : null,
    failNextPush: typeof r.failNextPush === 'string' ? r.failNextPush : null,
    failNextPull: typeof r.failNextPull === 'string' ? r.failNextPull : null,
  };
}

// ===========================================================================
// Deterministic randomness
// ===========================================================================

/** xorshift32. Never returns 0, so the sequence cannot collapse. */
export function xorshift32(seed: number): number {
  let x = Math.trunc(seed) | 0;
  if (x === 0) x = 0x9e3779b9 | 0;
  x ^= x << 13;
  x |= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x |= 0;
  return x === 0 ? 0x9e3779b9 | 0 : x;
}

/** Advance the stream, returning the new seed and a value in [0, 1). */
export function draw(seed: number): { seed: number; value: number } {
  const next = xorshift32(seed);
  return { seed: next, value: (next >>> 0) / 4_294_967_296 };
}

/** Inclusive on both ends. */
export function drawInt(seed: number, min: number, max: number): { seed: number; value: number } {
  if (max <= min) return { seed: xorshift32(seed), value: min };
  const d = draw(seed);
  return { seed: d.seed, value: min + Math.floor(d.value * (max - min + 1)) };
}

export function drawFrom<T>(seed: number, items: readonly T[]): { seed: number; value: T | null } {
  if (items.length === 0) return { seed: xorshift32(seed), value: null };
  const d = drawInt(seed, 0, items.length - 1);
  return { seed: d.seed, value: items[d.value]! };
}

// ===========================================================================
// Pricing
// ===========================================================================

/**
 * What the marketplace charges a party of N.
 *
 * A partner price schedule is "first traveller, then each additional" — which is
 * also the only shape that stays exact when the supplier's fee list mixes a flat
 * per-booking fee with percentage tax. Multiplying a single all-in price by the
 * party size would overcharge the flat fee once per head.
 */
export function retailQuote(rate: MockRateSnapshot, quantity: number): number {
  const qty = Math.max(1, Math.trunc(quantity));
  return rate.retailPriceCents + (qty - 1) * rate.retailIncrementCents;
}

// ===========================================================================
// Guests
// ===========================================================================

const FIRST_NAMES = [
  'Marisol', 'Devon', 'Priya', 'Hank', 'Yuki', 'Tomas', 'Alma', 'Reid',
  'Ingrid', 'Cassius', 'Noor', 'Odette', 'Bram', 'Lucia', 'Kwame', 'Sonia',
] as const;

const LAST_NAMES = [
  'Vasquez', 'Okonjo', 'Lindqvist', 'Barrow', 'Nakamura', 'Fenwick', 'Adeyemi',
  'Kowalski', 'Duarte', 'Mbeki', 'Halloran', 'Petrov', 'Sandoval', 'Whitaker',
] as const;

function drawGuest(seed: number, sequence: number) {
  const f = drawFrom(seed, FIRST_NAMES);
  const l = drawFrom(f.seed, LAST_NAMES);
  const firstName = f.value ?? 'Guest';
  const lastName = l.value ?? 'Traveller';
  // The local-part carries the sequence so two identically-named guests are two
  // Customer rows, not one merged record — the marketplace has no idea who is who.
  const email = `${firstName}.${lastName}.${sequence}`.toLowerCase() + '@mock-channel.test';
  const phone = `555-01${String(sequence % 100).padStart(2, '0')}`;
  return { seed: l.seed, customer: { firstName, lastName, email, phone } };
}

// ===========================================================================
// Pure state transitions
// ===========================================================================

/** Thrown when a forced outage fires; the service turns it into a sync error. */
export class MockChannelOutage extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MockChannelOutage';
  }
}

/**
 * Accept an inventory push, replacing the marketplace's snapshot wholesale.
 *
 * Outages are the driver's business, not this function's: a forced failure is
 * one-shot and has to clear the flag, which is a state write.
 */
export function applyPush(
  state: MockChannelState,
  listings: InventoryListing[],
  now: Date,
): { state: MockChannelState; result: PushInventoryResult } {
  const accepted: PushInventoryResult['accepted'] = [];
  const rejected: PushInventoryResult['rejected'] = [];
  const snapshots: MockListingSnapshot[] = [];
  let sequence = state.sequence;

  for (const listing of listings) {
    if (listing.rates.length === 0) {
      rejected.push({ listingId: listing.listingId, error: 'A product must have at least one price' });
      continue;
    }
    if (listing.slots.length === 0) {
      rejected.push({ listingId: listing.listingId, error: 'No availability in the published window' });
      continue;
    }
    // Reuse the reference from a previous push so the partner's product survives
    // a republish — losing it would duplicate the product on their side.
    const existing = state.listings.find((l) => l.listingId === listing.listingId);
    const externalRef = listing.externalRef ?? existing?.externalRef ?? `MOCK-LST-${++sequence}`;
    snapshots.push({
      externalRef,
      listingId: listing.listingId,
      activityId: listing.activityId,
      name: listing.name,
      minParticipants: listing.minParticipants,
      maxParticipants: listing.maxParticipants,
      rates: listing.rates.map((r) => ({
        rateId: r.rateId,
        name: r.name,
        retailPriceCents: r.retailPriceCents,
        retailIncrementCents: r.retailIncrementCents,
      })),
      slots: listing.slots.map((s) => ({
        timeslotId: s.timeslotId,
        startsAtIso: s.startsAtIso,
        remaining: s.remaining,
      })),
      pushedAtIso: now.toISOString(),
    });
    accepted.push({ listingId: listing.listingId, externalRef });
  }

  return {
    state: { ...state, sequence, listings: snapshots },
    result: { accepted, rejected },
  };
}

export interface BookingOverrides {
  listingExternalRef?: string;
  rateId?: string;
  timeslotId?: string;
  quantity?: number;
  prepaid?: boolean;
  /**
   * Sell one seat more than the snapshot says remains. The whole point of the
   * mock is that this is ACCEPTED here and rejected on import — proving the
   * booking service, not the marketplace, is what protects the boat.
   */
  oversell?: boolean;
}

/**
 * Manufacture one booking against the current snapshot and queue its notice.
 *
 * Returns `booking: null` when the marketplace has nothing sellable — no push has
 * happened yet, or every published departure is now in the past.
 */
export function queueBooking(
  state: MockChannelState,
  now: Date,
  config: MockChannelConfig,
  overrides: BookingOverrides = {},
): { state: MockChannelState; booking: MockBookingRecord | null; reason: string | null } {
  const nowMs = now.getTime();
  // A marketplace will not sell a departure that cannot hold the product's own
  // minimum party — offering it would only produce bookings we must reject for
  // being too small, which teaches the operator nothing.
  const sellable = (l: MockListingSnapshot, s: MockSlotSnapshot) =>
    Date.parse(s.startsAtIso) > nowMs && s.remaining >= Math.max(1, l.minParticipants);
  const candidates = state.listings.filter(
    (l) =>
      (overrides.listingExternalRef ? l.externalRef === overrides.listingExternalRef : true) &&
      l.rates.length > 0 &&
      l.slots.some((s) => sellable(l, s)),
  );
  if (candidates.length === 0) {
    return {
      state,
      booking: null,
      reason: overrides.listingExternalRef
        ? 'That listing has no future availability in the marketplace snapshot'
        : 'The marketplace has no sellable inventory — push first',
    };
  }

  let seed = state.seed;
  const pickedListing = drawFrom(seed, candidates);
  seed = pickedListing.seed;
  const listing = pickedListing.value!;

  const rates = overrides.rateId ? listing.rates.filter((r) => r.rateId === overrides.rateId) : listing.rates;
  const pickedRate = drawFrom(seed, rates);
  seed = pickedRate.seed;
  if (!pickedRate.value) {
    return { state, booking: null, reason: 'No such rate on that listing' };
  }
  const rate = pickedRate.value;

  const slots = listing.slots.filter(
    (s) => sellable(listing, s) && (overrides.timeslotId ? s.timeslotId === overrides.timeslotId : true),
  );
  const pickedSlot = drawFrom(seed, slots);
  seed = pickedSlot.seed;
  if (!pickedSlot.value) {
    return { state, booking: null, reason: 'No such departure on that listing' };
  }
  const slot = pickedSlot.value;

  const floor = Math.max(1, listing.minParticipants);
  const ceiling = Math.max(floor, Math.min(listing.maxParticipants, slot.remaining, config.maxPartySize));
  const drawnQty = drawInt(seed, floor, ceiling);
  seed = drawnQty.seed;
  let quantity = overrides.quantity ?? drawnQty.value;
  if (overrides.oversell) quantity = slot.remaining + 1;
  quantity = Math.max(1, Math.trunc(quantity));

  const sequence = state.sequence + 1;
  const guest = drawGuest(seed, sequence);
  seed = guest.seed;

  const booking: MockBookingRecord = {
    externalRef: `MOCK-BKG-${sequence}`,
    listingExternalRef: listing.externalRef,
    rateId: rate.rateId,
    timeslotId: slot.timeslotId,
    quantity,
    grossCents: retailQuote(rate, quantity),
    prepaid: overrides.prepaid ?? config.prepaid,
    status: 'CONFIRMED',
    customer: guest.customer,
    leadTravellerName: `${guest.customer.firstName} ${guest.customer.lastName}`,
    bookedAtIso: now.toISOString(),
    cancelledAtIso: null,
  };

  // The snapshot is decremented so the marketplace does not resell the same seat
  // within one snapshot — but it is NEVER refreshed from us between pushes, which
  // is precisely how it drifts into overselling.
  const listings = state.listings.map((l) =>
    l.externalRef === listing.externalRef
      ? {
          ...l,
          slots: l.slots.map((s) =>
            s.timeslotId === slot.timeslotId
              ? { ...s, remaining: Math.max(0, s.remaining - quantity) }
              : s,
          ),
        }
      : l,
  );

  return {
    state: {
      ...state,
      seed,
      sequence,
      listings,
      bookings: [...state.bookings, booking],
      outbox: [
        ...state.outbox,
        {
          id: `MOCK-NTC-${sequence}`,
          externalRef: booking.externalRef,
          status: 'CONFIRMED',
          queuedAtIso: now.toISOString(),
          deliveries: 0,
          acknowledged: false,
        },
      ],
    },
    booking,
    reason: null,
  };
}

/**
 * A guest cancels at the marketplace. Only a booking the partner believes we
 * received can be cancelled, so this picks from acknowledged, still-confirmed
 * bookings; the cancellation then arrives as an ordinary notice.
 */
export function queueGuestCancellation(
  state: MockChannelState,
  now: Date,
  externalRef?: string,
): { state: MockChannelState; externalRef: string | null; reason: string | null } {
  const acknowledgedRefs = new Set(
    state.outbox.filter((n) => n.acknowledged && n.status === 'CONFIRMED').map((n) => n.externalRef),
  );
  const eligible = state.bookings.filter(
    (b) =>
      b.status === 'CONFIRMED' &&
      acknowledgedRefs.has(b.externalRef) &&
      (externalRef ? b.externalRef === externalRef : true),
  );
  if (eligible.length === 0) {
    return {
      state,
      externalRef: null,
      reason: externalRef
        ? 'No confirmed, acknowledged booking with that reference'
        : 'Nothing to cancel — pull the confirmed bookings first',
    };
  }

  const picked = drawFrom(state.seed, eligible);
  const target = picked.value!;
  const sequence = state.sequence + 1;

  return {
    state: {
      ...state,
      seed: picked.seed,
      sequence,
      bookings: state.bookings.map((b) =>
        b.externalRef === target.externalRef
          ? { ...b, status: 'CANCELLED' as const, cancelledAtIso: now.toISOString() }
          : b,
      ),
      outbox: [
        ...state.outbox,
        {
          id: `MOCK-NTC-${sequence}`,
          externalRef: target.externalRef,
          status: 'CANCELLED',
          queuedAtIso: now.toISOString(),
          deliveries: 0,
          acknowledged: false,
        },
      ],
    },
    externalRef: target.externalRef,
    reason: null,
  };
}

/**
 * Advance the arrival schedule to `now`.
 *
 * The clock is advanced by whole intervals actually consumed rather than snapped
 * to `now`, so a capped run leaves the remainder owed and the next pull picks it
 * up. Snapping would silently swallow arrivals after a long clock jump.
 */
export function advanceArrivals(
  state: MockChannelState,
  now: Date,
  config: MockChannelConfig,
): { state: MockChannelState; created: number; cancelled: number } {
  const intervalMs = config.arrivalIntervalMinutes * 60_000;
  const last = state.lastArrivalAtIso ? Date.parse(state.lastArrivalAtIso) : null;
  // First ever pull: produce one arrival immediately rather than making the owner
  // wait an interval to see the feature work at all.
  const due = last === null ? 1 : Math.floor((now.getTime() - last) / intervalMs);
  if (due <= 0) return { state, created: 0, cancelled: 0 };

  const runs = Math.min(due, config.maxArrivalsPerPull);
  let next = state;
  let created = 0;
  let cancelled = 0;

  for (let i = 0; i < runs; i += 1) {
    // Cadence counts NOTICES, not the shared id sequence: an owner who sets
    // "every 7th" means one in seven things the partner sends, and the sequence
    // is also consumed by listing references.
    const nth = next.outbox.length + 1;
    const wantsCancellation =
      config.cancellationEveryNth > 0 && nth % config.cancellationEveryNth === 0;
    if (wantsCancellation) {
      const attempt = queueGuestCancellation(next, now);
      if (attempt.externalRef) {
        next = attempt.state;
        cancelled += 1;
        continue;
      }
      // Nothing cancellable yet — fall through and sell instead.
    }
    const attempt = queueBooking(next, now, config);
    if (!attempt.booking) break; // no inventory; stop burning the schedule
    next = attempt.state;
    created += 1;
  }

  const consumed = created + cancelled;
  const advancedFrom = last === null ? now.getTime() - intervalMs : last;
  return {
    state: {
      ...next,
      lastArrivalAtIso: new Date(advancedFrom + consumed * intervalMs).toISOString(),
    },
    created,
    cancelled,
  };
}

/** Notices the partner still wants us to see, oldest first. */
export function pendingNotices(state: MockChannelState, limit: number, since: Date | null): MockNotice[] {
  const sinceMs = since ? since.getTime() : null;
  return state.outbox
    .filter((n) => !n.acknowledged && (sinceMs === null || Date.parse(n.queuedAtIso) >= sinceMs))
    .sort((a, b) => Date.parse(a.queuedAtIso) - Date.parse(b.queuedAtIso))
    .slice(0, Math.max(0, limit));
}

export function markDelivered(state: MockChannelState, noticeIds: string[]): MockChannelState {
  const ids = new Set(noticeIds);
  return {
    ...state,
    outbox: state.outbox.map((n) => (ids.has(n.id) ? { ...n, deliveries: n.deliveries + 1 } : n)),
  };
}

/**
 * Acknowledge every DELIVERED notice for these references.
 *
 * Acking by reference rather than notice id matches how partners behave: the
 * supplier confirms it has absorbed booking X, not that it read message 47. A
 * notice we never delivered is left alone so an acknowledgement cannot race
 * ahead of a cancellation that has not been shown to us yet.
 */
export function acknowledgeNotices(state: MockChannelState, externalRefs: string[]): MockChannelState {
  const refs = new Set(externalRefs);
  return {
    ...state,
    outbox: state.outbox.map((n) =>
      refs.has(n.externalRef) && n.deliveries > 0 ? { ...n, acknowledged: true } : n,
    ),
  };
}

/** The supplier cancels at the partner. No inbound notice — we already know. */
export function applySupplierCancel(
  state: MockChannelState,
  externalRef: string,
  now: Date,
  config: MockChannelConfig,
): { state: MockChannelState; result: ChannelCancelResult } {
  const booking = state.bookings.find((b) => b.externalRef === externalRef);
  if (!booking) {
    return {
      state,
      result: { externalRef, accepted: false, penaltyCents: 0, reason: 'Unknown booking reference' },
    };
  }
  if (booking.status === 'CANCELLED') {
    // Idempotent: a retried cancellation is not a second penalty.
    return {
      state,
      result: { externalRef, accepted: true, penaltyCents: 0, reason: 'Already cancelled' },
    };
  }
  return {
    state: {
      ...state,
      bookings: state.bookings.map((b) =>
        b.externalRef === externalRef
          ? { ...b, status: 'CANCELLED' as const, cancelledAtIso: now.toISOString() }
          : b,
      ),
    },
    result: {
      externalRef,
      accepted: true,
      penaltyCents: config.cancellationPenaltyCents,
      reason: null,
    },
  };
}

/** Shape a stored booking + notice into the payload the service imports. */
export function toPayload(
  booking: MockBookingRecord,
  notice: MockNotice,
  channelName: string,
): ChannelBookingPayload {
  return {
    externalRef: booking.externalRef,
    status: notice.status,
    listingExternalRef: booking.listingExternalRef,
    rateId: booking.rateId,
    timeslotId: booking.timeslotId,
    quantity: booking.quantity,
    grossCents: booking.grossCents,
    // The mock states no commission: the marketplace remits later, so the
    // channel's configured percent is what applies at import time. A real OTA
    // that DOES state one exercises the other branch of settleChannelAmount.
    commissionCents: null,
    prepaid: booking.prepaid,
    customer: booking.customer,
    leadTravellerName: booking.leadTravellerName,
    bookedAtIso: booking.bookedAtIso,
    raw: {
      source: channelName,
      notificationId: notice.id,
      deliveryAttempt: notice.deliveries + 1,
      bookingReference: booking.externalRef,
      productReference: booking.listingExternalRef,
      optionCode: booking.rateId,
      availabilityCode: booking.timeslotId,
      travellers: booking.quantity,
      amountPaidCents: booking.grossCents,
      currency: 'USD',
      status: notice.status,
      bookedAt: booking.bookedAtIso,
      cancelledAt: booking.cancelledAtIso,
    },
  };
}

// ===========================================================================
// The driver
// ===========================================================================

/**
 * Build the MOCK driver over a channel's persisted state.
 *
 * Every method is load -> pure transition -> save, so a crash mid-method loses
 * the transition rather than half of it. The marketplace is a single operator's
 * private simulation, so a lost transition is a re-runnable button press.
 */
export function createMockChannelDriver(ctx: ChannelDriverContext): ChannelDriver {
  const config = mockChannelConfig(ctx.config);

  async function load(): Promise<MockChannelState> {
    return toMockState(await ctx.state.load(), config.seed);
  }
  async function save(state: MockChannelState): Promise<void> {
    await ctx.state.save(state as unknown as Record<string, unknown>);
  }

  return {
    kind: 'MOCK',

    async pushInventory(listings) {
      const state = await load();
      if (state.failNextPush) {
        await save({ ...state, failNextPush: null });
        throw new MockChannelOutage(state.failNextPush);
      }
      const pushed = applyPush(state, listings, ctx.now);
      await save(pushed.state);
      return pushed.result;
    },

    async pullBookings({ since, limit }) {
      const state = await load();
      if (state.failNextPull) {
        await save({ ...state, failNextPull: null });
        throw new MockChannelOutage(state.failNextPull);
      }

      const advanced = advanceArrivals(state, ctx.now, config);
      const notices = pendingNotices(advanced.state, limit, since);
      const bookingByRef = new Map(advanced.state.bookings.map((b) => [b.externalRef, b]));
      const bookings: ChannelBookingPayload[] = [];
      for (const notice of notices) {
        const booking = bookingByRef.get(notice.externalRef);
        if (booking) bookings.push(toPayload(booking, notice, ctx.channelName));
      }

      const delivered = markDelivered(advanced.state, notices.map((n) => n.id));
      await save(delivered);
      return { bookings, cursor: notices.at(-1)?.id ?? null } satisfies PullBookingsResult;
    },

    async acknowledge(externalRefs) {
      if (externalRefs.length === 0) return;
      const state = await load();
      await save(acknowledgeNotices(state, externalRefs));
    },

    async cancel({ externalRef }) {
      const state = await load();
      const outcome = applySupplierCancel(state, externalRef, ctx.now, config);
      await save(outcome.state);
      return outcome.result;
    },
  };
}

// ===========================================================================
// Console controls — the "on demand" half of the requirement
// ===========================================================================

export interface MockControlResult {
  ok: boolean;
  message: string;
  externalRef: string | null;
}

/** Manufacture one booking right now, ignoring the arrival schedule. */
export async function mockBookNow(
  ctx: ChannelDriverContext,
  overrides: BookingOverrides = {},
): Promise<MockControlResult> {
  const config = mockChannelConfig(ctx.config);
  const state = toMockState(await ctx.state.load(), config.seed);
  const outcome = queueBooking(state, ctx.now, config, overrides);
  if (!outcome.booking) {
    return { ok: false, message: outcome.reason ?? 'Could not create a booking', externalRef: null };
  }
  await ctx.state.save(outcome.state as unknown as Record<string, unknown>);
  return {
    ok: true,
    message: `Queued ${outcome.booking.externalRef} for ${outcome.booking.quantity} traveller(s)`,
    externalRef: outcome.booking.externalRef,
  };
}

/** Make a guest cancel, so the cancellation arrives on the next pull. */
export async function mockCancelNow(
  ctx: ChannelDriverContext,
  externalRef?: string,
): Promise<MockControlResult> {
  const config = mockChannelConfig(ctx.config);
  const state = toMockState(await ctx.state.load(), config.seed);
  const outcome = queueGuestCancellation(state, ctx.now, externalRef);
  if (!outcome.externalRef) {
    return { ok: false, message: outcome.reason ?? 'Nothing to cancel', externalRef: null };
  }
  await ctx.state.save(outcome.state as unknown as Record<string, unknown>);
  return {
    ok: true,
    message: `Guest cancelled ${outcome.externalRef}; it arrives on the next pull`,
    externalRef: outcome.externalRef,
  };
}

/** Arm a one-shot partner outage on the next push or pull. */
export async function mockForceOutage(
  ctx: ChannelDriverContext,
  which: 'push' | 'pull',
  message: string,
): Promise<MockControlResult> {
  const config = mockChannelConfig(ctx.config);
  const state = toMockState(await ctx.state.load(), config.seed);
  await ctx.state.save({
    ...state,
    ...(which === 'push' ? { failNextPush: message } : { failNextPull: message }),
  } as unknown as Record<string, unknown>);
  return { ok: true, message: `The next ${which} will fail with: ${message}`, externalRef: null };
}

/** What the marketplace currently believes, for the Local Console. */
export async function mockSnapshot(ctx: ChannelDriverContext) {
  const config = mockChannelConfig(ctx.config);
  const state = toMockState(await ctx.state.load(), config.seed);
  return {
    config,
    listings: state.listings.map((l) => ({
      externalRef: l.externalRef,
      name: l.name,
      activityId: l.activityId,
      rates: l.rates.length,
      slots: l.slots.length,
      seatsForSale: l.slots.reduce((n, s) => n + s.remaining, 0),
      pushedAt: l.pushedAtIso,
    })),
    bookings: state.bookings,
    outbox: state.outbox,
    lastArrivalAt: state.lastArrivalAtIso,
    pendingDelivery: state.outbox.filter((n) => !n.acknowledged).length,
    failNextPush: state.failNextPush,
    failNextPull: state.failNextPull,
  };
}
