/**
 * The suite's `test` and `expect`. Every spec imports from here, never from
 * `@playwright/test` directly, so the fixtures below are always available and the
 * page objects are always constructed the same way.
 *
 * Design rule for these fixtures: a fixture may DERIVE data (read the catalog, find an
 * open slot, mint a guest) eagerly, but it must not CREATE anything until a spec asks.
 * Otherwise every spec pays for a booking it may not need, and a shared side effect
 * turns independent tests into a chain.
 */
import { test as base, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { MarinaApi, makeClientIp, type OrderSummary } from './api';
import {
  deriveSelection,
  makeGuest,
  makeParticipants,
  makePromoCode,
  type BookingSelection,
  type Guest,
  type SelectionOptions,
} from './booking-data';
import { API_URL, TIMEZONE } from '../config';
import { addDays, isoDate, today } from '../helpers/datetime';
import {
  ActivityPage,
  BookingLookupPage,
  CatalogPage,
  CheckoutPage,
  ReschedulePanel,
} from '../helpers/customer';
import { AdminApp } from '../helpers/admin';
import { LocalConsole } from '../helpers/local-console';

/** A booking created straight through the API, with everything a spec needs about it. */
export interface SeededBooking {
  order: OrderSummary;
  orderNumber: string;
  guest: Guest;
  selection: BookingSelection;
}

/** What a spec asks for when it wants inventory nothing else is contending for. */
export interface OwnedSlotOptions {
  /** Guests the slot must be able to take. Raised to the activity's minimum party size. */
  quantity?: number;
  /**
   * Whole days from today, in the operator's timezone. Deliberately explicit: a spec
   * that says "at least 72 hours out" behaves differently at 9am and at 11pm, and a
   * spec that picks a fixed day offset does not.
   */
  daysAhead?: number;
  /** Local start hours to try, in order. The first usable one wins. */
  hours?: number[];
  /** Pin the slot to one activity — how a spec gets two slots it can move between. */
  activityId?: string;
}

/** Creates test data on demand and cleans up what it made. */
export interface Seed {
  /** Find a bookable activity/rate/slot on the live tenant. */
  selection(options?: SelectionOptions): Promise<BookingSelection>;
  /**
   * A timeslot this test owns: created if it does not exist, reused if a previous run
   * left one empty, and rejected if anything but its own capacity limits it.
   *
   * This is the answer to "my spec passes on a fresh seed and fails on the second
   * run". A spec that consumes shared seeded capacity is a spec whose result depends
   * on how many times the suite has run today. See docs/TESTING.md.
   */
  slot(options?: OwnedSlotOptions): Promise<BookingSelection>;
  /** A guest identity unique to this run. */
  guest(label?: string): Guest;
  /**
   * Create a paid booking through the API, exactly as the checkout flow would.
   *
   * For specs whose subject is what happens AFTER a booking exists — the operator's
   * day, self-service, the inbox. Driving the browser through checkout for those would
   * make a calendar-widget regression fail the refund test, which is the cascade the
   * suite is supposed to avoid.
   *
   * Pass `on` to book a selection the spec already reserved; otherwise one is derived.
   */
  booking(
    options?: SelectionOptions & { pay?: boolean; guestLabel?: string; on?: BookingSelection },
  ): Promise<SeededBooking>;
  /** A promo code owned by this test, deactivated when it finishes. */
  promo(options?: { percent?: number; activityIds?: string[] }): Promise<{ code: string; percent: number }>;
}

/**
 * Local start hours a spec's own slot may use, latest first.
 *
 * The seed opens every activity at 8, 10, 12, 14 and 16 (packages/database/prisma/
 * seed.ts), so these never land on a seeded slot — which matters twice over: the spec
 * gets a slot nothing else is booking into, and the time-chip locator
 * (`getByRole('radio', { name: /^8:00 PM/ })`) stays unambiguous because no two slots
 * on a day share a start time.
 */
const OWNED_SLOT_HOURS = [23, 22, 21, 20, 19, 18, 17, 15, 13, 11, 9, 7];

interface MarinaFixtures {
  /** Tenant-scoped API client, for deriving data and asserting server-side truth. */
  api: MarinaApi;
  /** On-demand test data. */
  seed: Seed;
  catalogPage: CatalogPage;
  activityPage: ActivityPage;
  checkoutPage: CheckoutPage;
  lookupPage: BookingLookupPage;
  reschedulePanel: ReschedulePanel;
  admin: AdminApp;
  console: LocalConsole;
}

export const test = base.extend<MarinaFixtures>({
  api: async ({}, use) => {
    const context: APIRequestContext = await playwrightRequest.newContext({ baseURL: API_URL });
    // One client address per test. See makeClientIp in ./api — without it the harness
    // spends the rate-limit budget the browser needs.
    await use(new MarinaApi(context, makeClientIp()));
    await context.dispose();
  },

  seed: async ({ api }, use) => {
    const createdPromoIds: string[] = [];
    const createdOrderIds: string[] = [];

    const seed: Seed = {
      selection: (options) => deriveSelection(api, options),

      slot: (options) => reserveSlot(api, options),

      guest: (label) => makeGuest(label),

      async booking(options = {}) {
        const { pay = true, guestLabel = 'seeded', on, ...selectionOptions } = options;
        const selection = on ?? (await deriveSelection(api, selectionOptions));
        const guest = makeGuest(guestLabel);

        const order = await api.createBooking({
          activityId: selection.activity.id,
          rateId: selection.rate.id,
          timeslotId: selection.slot.timeslotId,
          quantity: selection.quantity,
          customer: {
            first_name: guest.firstName,
            last_name: guest.lastName,
            email: guest.email,
            phone: guest.phone,
          },
          participants: makeParticipants(guest, selection.quantity),
        });
        createdOrderIds.push(order.id);

        if (pay && order.balanceDueCents > 0) {
          await api.charge(order.id);
        }

        // Re-read so the caller sees settled money, not the pre-charge snapshot.
        const settled = pay ? await api.order(order.orderNumber) : order;

        // A booking the fixture believes is paid but is not turns into a puzzling
        // assertion four steps later — usually "the price changed" on a reschedule.
        // The cause is almost always the payment simulator's queue: it is per-operator
        // global state, so an outcome another spec queued and never consumed is popped
        // by THIS charge. Say that here, where it is still obvious.
        if (pay && settled.balanceDueCents !== 0) {
          const queue = await api.paymentQueue().catch(() => null);
          throw new Error(
            `Seeded booking ${settled.orderNumber} did not settle: ${settled.balanceDueCents} cents ` +
              `still due. The payment simulator's next outcome was ` +
              `${queue ? queue.nextOutcome : 'unreadable'} — a scripted outcome left behind by ` +
              'another spec will hijack the next charge on this tenant (see docs/TESTING.md).',
          );
        }

        return { order: settled, orderNumber: settled.orderNumber, guest, selection };
      },

      async promo(options = {}) {
        const percent = options.percent ?? 10;
        const code = makePromoCode();
        const created = await api.createPromo({
          code,
          name: `E2E ${percent}% off`,
          discount_type: 'PERCENT',
          discount_value: percent,
          activity_ids: options.activityIds ?? [],
        });
        createdPromoIds.push(created.id);
        return { code, percent };
      },
    };

    await use(seed);

    // Give the capacity back. A booking left standing is capacity permanently removed
    // from the tenant, and a suite that removes a little capacity on every run is a
    // suite that only passes on a freshly seeded database — which is the difference
    // between a test and a countdown. Cancelling restores the timeslot's seats and
    // releases any shared resource the item held.
    for (const id of createdOrderIds) await api.cancelOrder(id, 'e2e cleanup');

    // A live promo code left behind would show up in the operator's real promo list and
    // could be redeemed by an actual guest on this tenant. Deactivating is enough —
    // deleting would orphan the redemption rows on the orders this run created.
    for (const id of createdPromoIds) await api.deactivatePromo(id);
  },

  catalogPage: async ({ page }, use) => use(new CatalogPage(page)),
  activityPage: async ({ page }, use) => use(new ActivityPage(page)),
  checkoutPage: async ({ page }, use) => use(new CheckoutPage(page)),
  lookupPage: async ({ page }, use) => use(new BookingLookupPage(page)),
  reschedulePanel: async ({ page }, use) => use(new ReschedulePanel(page)),
  admin: async ({ page }, use) => use(new AdminApp(page)),
  console: async ({ page }, use) => use(new LocalConsole(page)),
});

// ---------------------------------------------------------------------------
// Owned inventory
// ---------------------------------------------------------------------------

/** Local clock hour (0–23) of an instant, in the operator's timezone. */
function hourOf(datetime: string): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(datetime)),
  );
}

/**
 * Reserve a timeslot the calling test owns, on a day and at an hour of its choosing.
 *
 * Three things have to be true of the slot it hands back, and each one was a real
 * source of flake before it was checked:
 *
 *  1. **Nothing else is booked into it.** A slot the seed shipped is inventory every
 *     other spec is also spending, so a spec that takes the "first open slot" gets a
 *     different slot on every run and eventually none at all.
 *  2. **Its own capacity is the only thing limiting it.** Availability reports the MIN
 *     of a slot's capacity and what the shared resource pools can still honour
 *     (D-014), so on a pool-constrained slot the published numbers move when a boat
 *     moves, not when this slot's seats move. `limitedBy` is how the API says which it
 *     is; a slot that reports one is skipped rather than reasoned about.
 *  3. **It exists at a known wall-clock time**, so a time-chip locator names exactly
 *     one control.
 *
 * Reuse before create: a slot a previous run made and then released is exactly as good
 * as a new one, and reusing it means repeated runs stop adding rows forever.
 */
async function reserveSlot(api: MarinaApi, options: OwnedSlotOptions = {}): Promise<BookingSelection> {
  const requestedQty = options.quantity ?? 1;
  const daysAhead = options.daysAhead ?? 5;
  const hours = options.hours ?? OWNED_SLOT_HOURS;
  const date = daysAhead === 0 ? today() : isoDate(addDays(`${today()}T12:00:00`, daysAhead));

  const catalog = await api.catalog();
  const candidates = options.activityId
    ? catalog.filter((a) => a.id === options.activityId)
    : catalog.filter((a) => a.rates.length > 0 && a.maxParticipants >= requestedQty);

  const rejected: string[] = [];

  for (const summary of candidates) {
    const activity = await api.activity(summary.id);
    // An activity with a minimum party size silently raises the quantity in the
    // booking widget; match it so the fixture's totals equal the ones on screen.
    const quantity = Math.max(requestedQty, activity.minParticipants || 1);
    if (activity.maxParticipants > 0 && quantity > activity.maxParticipants) continue;
    if (activity.rates.length === 0) continue;
    // One seat of headroom above what the test books, so the slot still reads as
    // bookable (not FULL) while the test's own booking is sitting in it.
    const capacityTotal = quantity + 1;
    const rate = activity.rates.reduce((min, r) => (r.priceCents < min.priceCents ? r : min));

    let day = await api.timeslots(activity.id, date);

    for (const hour of hours) {
      let slot = day.find((s) => hourOf(s.datetime) === hour);

      if (!slot) {
        const created = await api.generateTimeslots({
          activityId: activity.id,
          from: date,
          to: date,
          openHour: hour,
          closeHour: hour + 1,
          intervalMinutes: 60,
          capacityTotal,
        });
        if (created.created === 0) continue;
        day = await api.timeslots(activity.id, date);
        slot = day.find((s) => hourOf(s.datetime) === hour);
        if (!slot) continue;
      }

      const usable =
        slot.capacityBooked === 0 &&
        slot.limitedBy === null &&
        slot.capacityRemaining === slot.capacityTotal &&
        slot.capacityTotal >= capacityTotal;
      if (!usable) {
        rejected.push(
          `${activity.name} ${date} ${hour}:00 — booked ${slot.capacityBooked}/${slot.capacityTotal}` +
            (slot.limitedBy ? `, limited by ${slot.limitedBy.resourceName}` : ''),
        );
        continue;
      }

      return {
        activity,
        rate,
        slot: {
          timeslotId: slot.id,
          datetime: slot.datetime,
          capacityTotal: slot.capacityTotal,
          capacityBooked: slot.capacityBooked,
          capacityRemaining: slot.capacityRemaining,
          status: slot.status,
        },
        date,
        quantity,
        subtotalCents: rate.priceCents * quantity,
      };
    }
  }

  throw new Error(
    `Could not reserve a slot this test owns on ${date} at any of ${hours.join(', ')} ` +
      `(quantity ${requestedQty}` +
      (options.activityId ? `, activity ${options.activityId}` : '') +
      `). Rejected: ${rejected.length > 0 ? rejected.join('; ') : 'no candidate activities'}.`,
  );
}

export { expect };
export type { BookingSelection, Guest, OrderSummary };
