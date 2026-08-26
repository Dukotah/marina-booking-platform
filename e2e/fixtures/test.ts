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
import { MarinaApi, type OrderSummary } from './api';
import {
  deriveSelection,
  makeGuest,
  makeParticipants,
  makePromoCode,
  type BookingSelection,
  type Guest,
  type SelectionOptions,
} from './booking-data';
import { API_URL } from '../config';
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

/** Creates test data on demand and cleans up what it made. */
export interface Seed {
  /** Find a bookable activity/rate/slot on the live tenant. */
  selection(options?: SelectionOptions): Promise<BookingSelection>;
  /** A guest identity unique to this run. */
  guest(label?: string): Guest;
  /**
   * Create a paid booking through the API, exactly as the checkout flow would.
   *
   * For specs whose subject is what happens AFTER a booking exists — the operator's
   * day, self-service, the inbox. Driving the browser through checkout for those would
   * make a calendar-widget regression fail the refund test, which is the cascade the
   * suite is supposed to avoid.
   */
  booking(options?: SelectionOptions & { pay?: boolean; guestLabel?: string }): Promise<SeededBooking>;
  /** A promo code owned by this test, deactivated when it finishes. */
  promo(options?: { percent?: number; activityIds?: string[] }): Promise<{ code: string; percent: number }>;
}

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
    await use(new MarinaApi(context));
    await context.dispose();
  },

  seed: async ({ api }, use) => {
    const createdPromoIds: string[] = [];

    const seed: Seed = {
      selection: (options) => deriveSelection(api, options),

      guest: (label) => makeGuest(label),

      async booking(options = {}) {
        const { pay = true, guestLabel = 'seeded', ...selectionOptions } = options;
        const selection = await deriveSelection(api, selectionOptions);
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

        if (pay && order.balanceDueCents > 0) {
          await api.charge(order.id);
        }

        // Re-read so the caller sees settled money, not the pre-charge snapshot.
        const settled = pay ? await api.order(order.orderNumber) : order;
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

export { expect };
export type { BookingSelection, Guest, OrderSummary };
