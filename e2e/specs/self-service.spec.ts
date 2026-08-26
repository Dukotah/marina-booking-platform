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
 */
import { expect, test, type BookingSelection } from '../fixtures/test';
import type { MarinaApi } from '../fixtures/api';
import { addDays, hoursFromNow, isoDate, longDateLabel, timeLabel, today } from '../helpers/datetime';

/**
 * How far out a booking must sit for a guest to be allowed to move it themselves. The
 * activity's `self_reschedule_hours` (48 by default) is enforced server-side; asking
 * for a slot comfortably beyond it keeps these tests about the flow rather than about
 * the window.
 */
const BEYOND_RESCHEDULE_WINDOW_HOURS = 72;

test.describe('customer self-service', () => {
  test('a guest looks up their booking with the number and email', async ({
    page,
    seed,
    lookupPage,
  }) => {
    const { orderNumber, guest, selection } = await seed.booking({ guestLabel: 'lookup' });

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
    const { orderNumber } = await seed.booking({ guestLabel: 'wrongmail' });

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
    const { order, orderNumber, guest, selection } = await seed.booking({
      guestLabel: 'resched',
      minHoursAhead: BEYOND_RESCHEDULE_WINDOW_HOURS,
    });

    // A second slot on the same activity to move to. Derived, not assumed: the seed's
    // schedule shape is not this test's business.
    const target = await findOtherSlot(api, selection);

    await lookupPage.openBooking(orderNumber, guest.email);
    await reschedulePanel.open();
    await reschedulePanel.chooseItemIfAsked(selection.activity.name);
    await reschedulePanel.chooseDate(target.datetime);
    await reschedulePanel.chooseTime(target.datetime);
    await reschedulePanel.confirm();

    // The dialog says it moved. What matters is that the ORDER moved.
    const moved = await api.order(orderNumber);
    expect(moved.items[0]!.datetime).not.toBe(selection.slot.datetime);
    expect(new Date(moved.items[0]!.datetime).toISOString()).toBe(
      new Date(target.datetime).toISOString(),
    );

    // No rebooking, no re-payment: the money is untouched by a reschedule.
    expect(moved.totalCents, 'a reschedule must not change the price').toBe(order.totalCents);
    expect(moved.amountPaidCents).toBe(order.amountPaidCents);
    expect(moved.balanceDueCents).toBe(0);

    // And the page a guest reloads has to show the new time, not the old one.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText(longDateLabel(target.datetime)).first()).toBeVisible();
    await expect(page.getByText(timeLabel(target.datetime)).first()).toBeVisible();
  });

  test('the freed slot goes back into inventory', async ({ api, seed, lookupPage, reschedulePanel }) => {
    // Availability that lies is the thing operators get burned by. Moving a booking has
    // to give the old slot's seats back, not just take new ones.
    const { orderNumber, guest, selection } = await seed.booking({
      guestLabel: 'inventory',
      minHoursAhead: BEYOND_RESCHEDULE_WINDOW_HOURS,
    });
    const target = await findOtherSlot(api, selection);

    const before = await slotState(api, selection.activity.id, selection.date, selection.slot.timeslotId);

    await lookupPage.openBooking(orderNumber, guest.email);
    await reschedulePanel.open();
    await reschedulePanel.chooseItemIfAsked(selection.activity.name);
    await reschedulePanel.chooseDate(target.datetime);
    await reschedulePanel.chooseTime(target.datetime);
    await reschedulePanel.confirm();

    const after = await slotState(api, selection.activity.id, selection.date, selection.slot.timeslotId);
    expect(after.capacityBooked, 'the vacated slot must release its seats').toBe(
      before.capacityBooked - selection.quantity,
    );
  });
});

/**
 * Another open slot for the same activity that a guest could actually pick.
 *
 * Searched from TODAY, not from the booking's own date: the reschedule dialog's day
 * strip is anchored on today and shows fourteen days, so a slot outside that window is
 * one the test could only reach by opening the month grid — extra steps that would be
 * testing the calendar rather than the reschedule.
 */
async function findOtherSlot(
  api: MarinaApi,
  selection: BookingSelection,
): Promise<{ datetime: string; timeslotId: string }> {
  const start = today();

  for (let offset = 0; offset < 14; offset++) {
    const date = offset === 0 ? start : isoDate(addDays(`${start}T12:00:00`, offset));
    const day = await api.availability(selection.activity.id, date);
    const slot = day.slots.find(
      (s) =>
        s.timeslotId !== selection.slot.timeslotId &&
        s.status !== 'FULL' &&
        s.capacityRemaining >= selection.quantity &&
        hoursFromNow(s.datetime) >= BEYOND_RESCHEDULE_WINDOW_HOURS,
    );
    if (slot) return { datetime: slot.datetime, timeslotId: slot.timeslotId };
  }

  throw new Error(
    `No second open slot for "${selection.activity.name}" in the next 14 days that is at least ` +
      `${BEYOND_RESCHEDULE_WINDOW_HOURS}h out. Reseed with \`pnpm db:reset\` (see docs/TESTING.md).`,
  );
}

async function slotState(
  api: MarinaApi,
  activityId: string,
  date: string,
  timeslotId: string,
): Promise<{ capacityBooked: number; capacityRemaining: number }> {
  const day = await api.availability(activityId, date);
  const slot = day.slots.find((s) => s.timeslotId === timeslotId);
  if (!slot) throw new Error(`Timeslot ${timeslotId} is no longer listed on ${date}`);
  return { capacityBooked: slot.capacityBooked, capacityRemaining: slot.capacityRemaining };
}
