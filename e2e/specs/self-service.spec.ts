/**
 * Customer self-service: find my booking, then move it.
 *
 * Both of these are things a guest does alone on a phone at the dock, and both are
 * things an operator currently answers by hand — so the value is in them working
 * without anyone at the marina being involved.
 *
 * The bookings these tests need are created through the API rather than by walking
 * checkout: the subject is the lookup and the reschedule, and a booking made in three
 * seconds instead of thirty is three seconds of surface area that cannot break them.
 *
 * WHAT THIS FILE GUARANTEES ABOUT ITS OWN DATA (docs/TESTING.md spells out the rule):
 * every slot it books into is a slot it reserved for itself — created if absent, reused
 * if a previous run left it empty, and rejected unless the slot's own capacity is the
 * only thing limiting it. It books on fixed day offsets rather than "at least N hours
 * out", so the same slots are chosen at 9am and at 11:59pm. It clears the payment
 * simulator's queue before each test, because that queue is per-operator global. And
 * the seed fixture cancels every booking it made when the test ends, so the run leaves
 * the tenant's capacity exactly as it found it.
 */
import { expect, test, type BookingSelection, type Seed } from '../fixtures/test';
import type { MarinaApi } from '../fixtures/api';
import { longDateLabel, timeLabel } from '../helpers/datetime';

/**
 * Where this file puts its own inventory.
 *
 * The booking to be moved sits a day LATER than the slot it moves to, and both sit
 * whole days out. Two reasons, both of which were sources of flake:
 *
 *  - Whole days, not "at least 72 hours". `self_reschedule_hours` (48 by default) is
 *    enforced server-side, and a search for "the first slot beyond 72 hours" picks a
 *    different slot depending on the time of day it runs — right at a boundary it can
 *    pick one that is barely eligible. Day+5 and day+6 are never less than ~92 hours
 *    out whatever the clock says, and both are inside the reschedule dialog's 14-day
 *    day strip, so nothing has to open the month grid.
 *  - Moving BACKWARDS in time. Availability reports a slot's capacity net of the shared
 *    resource pools it draws on (D-014), measured over a window that starts at the slot
 *    and runs for the activity's LONGEST rate — up to 24 hours for a boat. A booking
 *    moved to a later slot on the same day is still inside that window, so the seats
 *    it vacates do not come back in the published number and "the freed slot goes back
 *    into inventory" fails while the product is behaving perfectly. Landing the move
 *    before the slot it left keeps the two windows disjoint, and the test measures the
 *    slot instead of the fleet.
 */
const BOOKING_DAYS_AHEAD = 6;
const TARGET_DAYS_AHEAD = 5;

/** Late hours, so the spec's slots never collide with the seed's 8/10/12/14/16. */
const OWNED_HOURS = [23, 22, 21];

test.describe('customer self-service', () => {
  test.beforeEach(async ({ api }) => {
    // The payment simulator's outcome queue is per-OPERATOR global state: whichever
    // charge arrives first pops it. A spec that queued "decline" and did not consume it
    // hands this file a booking that never settles, which surfaces three assertions
    // later as "a reschedule changed the price". Start from a known state, and say so
    // when the previous file left something behind rather than swallowing it.
    const queue = await api.paymentQueue();
    if (queue.scripted) {
      const cleared = await api.clearPaymentQueue();
      console.warn(
        `[e2e] self-service found ${cleared} scripted payment outcome(s) left over ` +
          `(next charge would have been ${queue.nextOutcome}) and cleared them.`,
      );
    }
  });

  test('a guest looks up their booking with the number and email', async ({
    page,
    seed,
    lookupPage,
  }) => {
    const { orderNumber, guest, selection } = await seed.booking({
      guestLabel: 'lookup',
      on: await seed.slot({ daysAhead: TARGET_DAYS_AHEAD, hours: OWNED_HOURS }),
    });

    await lookupPage.open();
    await lookupPage.lookup(orderNumber, guest.email);

    await expect(page.getByText(selection.activity.name).first()).toBeVisible();
    await expect(page.getByText(longDateLabel(selection.slot.datetime)).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Manage this booking' })).toBeVisible();
  });

  test('a wrong email does not reveal that the booking exists', async ({ page, seed, lookupPage }) => {
    // The lookup is the identity gate for every self-service change, so the failure has
    // to be indistinguishable from "no such booking" — otherwise the form is an oracle
    // for guessing valid order numbers.
    const { orderNumber } = await seed.booking({
      guestLabel: 'wrongmail',
      on: await seed.slot({ daysAhead: TARGET_DAYS_AHEAD, hours: OWNED_HOURS }),
    });

    await lookupPage.open();
    await page.getByLabel('Confirmation number').fill(orderNumber);
    await page.getByLabel('Email', { exact: false }).fill('not-the-booker@marina-e2e.test');
    await page.getByRole('button', { name: 'Find my booking' }).click();

    const failure = page.getByText(/could not find|no booking|check your details/i).first();
    await expect(failure).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/account$/);
  });

  test('a guest reschedules their own booking to another time', async ({
    page,
    api,
    seed,
    lookupPage,
    reschedulePanel,
  }) => {
    const { from, to } = await reserveMove(seed);
    const { order, orderNumber, guest } = await seed.booking({ guestLabel: 'resched', on: from });

    await lookupPage.openBooking(orderNumber, guest.email);
    await reschedulePanel.open();
    await reschedulePanel.chooseItemIfAsked(from.activity.name);
    await reschedulePanel.chooseDate(to.slot.datetime);
    await reschedulePanel.chooseTime(to.slot.datetime);
    await reschedulePanel.confirm();

    // The dialog says it moved. What matters is that the ORDER moved.
    const moved = await api.order(orderNumber);
    expect(moved.items[0]!.datetime).not.toBe(from.slot.datetime);
    expect(new Date(moved.items[0]!.datetime).toISOString()).toBe(
      new Date(to.slot.datetime).toISOString(),
    );

    // No rebooking, no re-payment: the money is untouched by a reschedule.
    expect(moved.totalCents, 'a reschedule must not change the price').toBe(order.totalCents);
    expect(moved.amountPaidCents).toBe(order.amountPaidCents);
    expect(moved.balanceDueCents).toBe(0);

    // And the page a guest reloads has to show the new time, not the old one. The two
    // slots are on different days AND at different times precisely so that this is a
    // real assertion rather than one a failed move could still satisfy.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText(longDateLabel(to.slot.datetime)).first()).toBeVisible();
    await expect(page.getByText(timeLabel(to.slot.datetime)).first()).toBeVisible();
    await expect(
      page.getByText(longDateLabel(from.slot.datetime)),
      'the booking it was moved away from must not still be on the page',
    ).toHaveCount(0);
  });

  test('the freed slot goes back into inventory', async ({ api, seed, lookupPage, reschedulePanel }) => {
    // Availability that lies is the thing operators get burned by. Moving a booking has
    // to give the old slot's seats back, not just take new ones.
    const { from, to } = await reserveMove(seed);
    const { orderNumber, guest } = await seed.booking({ guestLabel: 'inventory', on: from });

    const before = await slotState(api, from);
    expect(before.capacityBooked, 'the spec owns this slot, so its booking is the only one').toBe(
      from.quantity,
    );

    await lookupPage.openBooking(orderNumber, guest.email);
    await reschedulePanel.open();
    await reschedulePanel.chooseItemIfAsked(from.activity.name);
    await reschedulePanel.chooseDate(to.slot.datetime);
    await reschedulePanel.chooseTime(to.slot.datetime);
    await reschedulePanel.confirm();

    const after = await slotState(api, from);
    expect(after.capacityBooked, 'the vacated slot must release its seats').toBe(
      before.capacityBooked - from.quantity,
    );
    expect(after.capacityRemaining, 'and offer them for sale again').toBe(from.slot.capacityTotal);
  });
});

/**
 * The pair of slots a move needs: one to book, one to move to, on the same activity.
 *
 * Both are reserved BEFORE anything is booked, so each is verified empty and
 * unconstrained on its own terms. Reserving them the other way round would measure the
 * second slot with the first slot's booking already weighing on the shared pool.
 */
async function reserveMove(seed: Seed): Promise<{ from: BookingSelection; to: BookingSelection }> {
  const from = await seed.slot({ daysAhead: BOOKING_DAYS_AHEAD, hours: OWNED_HOURS });
  const to = await seed.slot({
    daysAhead: TARGET_DAYS_AHEAD,
    hours: OWNED_HOURS,
    activityId: from.activity.id,
  });

  // State the guarantee the "freed slot" assertion rests on instead of assuming it:
  // the booking's new window must end no later than the old slot begins, or the old
  // slot's published capacity is still answering for the seats this booking holds.
  const gapMs = new Date(from.slot.datetime).getTime() - new Date(to.slot.datetime).getTime();
  expect(
    gapMs,
    'the slot moved to must finish before the slot moved from begins, or the shared-resource ' +
      'window makes the release invisible',
  ).toBeGreaterThanOrEqual(to.rate.durationMinutes * 60_000);

  return { from, to };
}

/**
 * One slot's capacity as the API publishes it, with a check that the number means what
 * the caller thinks it means.
 *
 * `limitedBy` is the API saying "this figure is about a boat, not about this slot". A
 * capacity assertion made against a resource-limited slot is measuring the fleet, and
 * would pass or fail depending on what the rest of the marina is doing.
 */
async function slotState(
  api: MarinaApi,
  selection: BookingSelection,
): Promise<{ capacityBooked: number; capacityRemaining: number }> {
  const day = await api.timeslots(selection.activity.id, selection.date);
  const slot = day.find((s) => s.id === selection.slot.timeslotId);
  if (!slot) {
    throw new Error(`Timeslot ${selection.slot.timeslotId} is no longer listed on ${selection.date}`);
  }
  expect(
    slot.limitedBy,
    `${selection.activity.name} at ${selection.slot.datetime} is limited by a shared resource ` +
      `(${slot.limitedBy?.reason}), so its published capacity is not this slot's own`,
  ).toBeNull();
  return { capacityBooked: slot.capacityBooked, capacityRemaining: slot.capacityRemaining };
}
