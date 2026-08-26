/**
 * Test data the suite derives for itself.
 *
 * No spec is allowed to assume "order LSRA260604001 exists" or "SONOMA10 is live" —
 * the season seed is regenerated, the Local Console has a Reset button, and another
 * agent's run may have consumed exactly the slot you wanted. So every run:
 *
 *   1. reads the live catalog and picks a bookable activity + rate,
 *   2. scans forward day by day for a slot that genuinely has room,
 *   3. mints a guest identity unique to this run (so the confirmation email is
 *      findable in the inbox, and repeat runs never collide on a customer record),
 *   4. creates its own promo code when it needs one, and deactivates it after.
 *
 * The one thing it does assume is that the tenant has a seeded, bookable catalog.
 * Global setup checks that up front and fails with an instruction rather than letting
 * twenty specs fail obscurely.
 */
import type { ActivityDetail, AvailabilitySlot, MarinaApi } from './api';
import { addDays, hoursFromNow, isoDate, today } from '../helpers/datetime';

/** How far ahead to look for a bookable slot. The day strip on the activity page shows
 *  14 days, so anything further would need the month grid opened — pointless work for
 *  a funnel test. */
const SEARCH_DAYS = 14;

/** A fully-resolved, checkout-ready selection. */
export interface BookingSelection {
  activity: ActivityDetail;
  rate: ActivityDetail['rates'][number];
  slot: AvailabilitySlot;
  /** Operator-local calendar day of the slot, `YYYY-MM-DD`. */
  date: string;
  quantity: number;
  /** Line subtotal before promo, tax and fees — integer cents. */
  subtotalCents: number;
}

/** A guest identity unique to this test run. */
export interface Guest {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  fullName: string;
}

export interface SelectionOptions {
  /**
   * Only consider slots at least this many hours out. Customer self-reschedule is
   * gated on the activity's `self_reschedule_hours` (48 by default), so the
   * self-service spec asks for a booking comfortably beyond it.
   */
  minHoursAhead?: number;
  /** Guests to book. The slot must have at least this much room left. */
  quantity?: number;
  /** Only pick activities that require a signed waiver (the funnel spec wants one). */
  requireWaiver?: boolean;
  /** Skip these activity ids — used to find a *second*, different activity. */
  excludeActivityIds?: string[];
}

/** Raised when the tenant's data cannot satisfy a spec's needs, with what to do about it. */
export class NoBookableSlotError extends Error {
  constructor(criteria: string) {
    super(
      `No bookable slot in the next ${SEARCH_DAYS} days matching ${criteria}. ` +
        'The tenant is out of open capacity or has no future timeslots — reseed with ' +
        '`pnpm db:reset` (see docs/TESTING.md).',
    );
    this.name = 'NoBookableSlotError';
  }
}

/**
 * Find a bookable activity/rate/slot on the live tenant.
 *
 * Activities are tried in catalog order and slots earliest-first, so a run picks the
 * same thing twice in a row when nothing has changed — a stable choice makes a failure
 * reproducible, which a "random activity" strategy would not.
 */
export async function deriveSelection(
  api: MarinaApi,
  options: SelectionOptions = {},
): Promise<BookingSelection> {
  const requestedQty = options.quantity ?? 1;
  const minHours = options.minHoursAhead ?? 0;
  const excluded = new Set(options.excludeActivityIds ?? []);

  const catalog = await api.catalog();
  const candidates = catalog.filter(
    (a) =>
      !excluded.has(a.id) &&
      a.rates.length > 0 &&
      a.maxParticipants >= requestedQty &&
      (!options.requireWaiver || a.waiverRequired),
  );

  for (const summary of candidates) {
    const activity = await api.activity(summary.id);
    // An activity with a minimum party size silently raises the quantity in the
    // booking widget; matching that here keeps the fixture's totals equal to the
    // ones the screen will show.
    const quantity = Math.max(requestedQty, activity.minParticipants || 1);
    if (activity.maxParticipants > 0 && quantity > activity.maxParticipants) continue;

    const found = await findSlot(api, activity, quantity, minHours);
    if (!found) continue;

    return {
      activity,
      rate: found.rate,
      slot: found.slot,
      date: found.date,
      quantity,
      subtotalCents: found.rate.priceCents * quantity,
    };
  }

  throw new NoBookableSlotError(
    `quantity=${requestedQty}, minHoursAhead=${minHours}` +
      (options.requireWaiver ? ', waiverRequired' : '') +
      (excluded.size > 0 ? `, excluding ${excluded.size} activity(ies)` : ''),
  );
}

async function findSlot(
  api: MarinaApi,
  activity: ActivityDetail,
  quantity: number,
  minHours: number,
): Promise<{ slot: AvailabilitySlot; date: string; rate: ActivityDetail['rates'][number] } | null> {
  // The cheapest rate keeps the money assertions small and the totals easy to read in
  // a failure message; any rate would do functionally.
  const rate = activity.rates.reduce((min, r) => (r.priceCents < min.priceCents ? r : min));
  const start = today();

  for (let offset = 0; offset < SEARCH_DAYS; offset++) {
    const date = offset === 0 ? start : isoDate(addDays(`${start}T12:00:00`, offset));
    const day = await api.availability(activity.id, date);
    const slot = day.slots.find(
      (s) =>
        s.status !== 'FULL' &&
        s.capacityRemaining >= quantity &&
        hoursFromNow(s.datetime) >= minHours,
    );
    if (slot) return { slot, date, rate };
  }
  return null;
}

/**
 * A guest identity unique to this run. The email carries the run id so the Local
 * Console inbox can be searched for exactly this booking's confirmation, and two
 * concurrent workers never write to the same Customer row.
 */
export function makeGuest(label = 'guest'): Guest {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const firstName = 'Playwright';
  const lastName = `${capitalize(label)}${stamp.slice(-4).toUpperCase()}`;
  return {
    firstName,
    lastName,
    email: `e2e.${label}.${stamp}@marina-e2e.test`,
    // A phone number is what makes the confirmation SMS fire at all, and `toE164` in
    // apps/api/src/services/sms.ts rejects anything that is not 10 (or 11) digits — so
    // a bare 555-0100 would silently skip the text the inbox spec is looking for.
    // 707-555-01xx is the reserved-fictional range for Sonoma County's area code.
    phone: '707-555-0142',
    fullName: `${firstName} ${lastName}`,
  };
}

/** A promo code unique to this run, so no spec depends on what the seed shipped. */
export function makePromoCode(): string {
  return `E2E${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

/** Participant rows sized to the quantity, valid against `participantInfoSchema`. */
export function makeParticipants(guest: Guest, quantity: number): Array<{ driver_name: string }> {
  return Array.from({ length: quantity }, (_, i) => ({
    driver_name: i === 0 ? guest.fullName : `${guest.firstName} Guest${i + 1}`,
  }));
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
