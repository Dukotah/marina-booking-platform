/**
 * The funnel on a phone, on bad cell service, against a clock.
 *
 * "Booking has to take seconds on bad rural cell service" is the sharpest
 * differentiator in the contract (docs/LOCAL-FIRST-BUILD.md §2), and §6 requires it to
 * be "measured by an automated test with network throttling, not by feel". This is that
 * test.
 *
 * How the number is produced, stated plainly because a performance figure whose method
 * is unclear is worth nothing:
 *
 *   - The routes are warmed UNTHROTTLED first. `next dev` compiles a route on its first
 *     request, which can take tens of seconds and says nothing about how fast the page
 *     is for a guest. Warming measures the product instead of the build.
 *   - Throttling is real: DevTools' Slow 4G latency and bandwidth via CDP, plus a 4x CPU
 *     slowdown, which is roughly a mid-range Android.
 *   - The clock starts when the guest lands on the activity page and stops when the
 *     confirmation is on screen. Deriving the slot and filling the fixture happen before
 *     the clock starts; they are not part of the guest's journey.
 *
 * Because this runs in the `mobile-throttled` project it uses a Pixel 7 viewport and
 * touch emulation, so it also catches the thing a desktop run never would: a control
 * that is unreachable or unreadably small on a phone.
 */
import { expect, test } from '../fixtures/test';
import { MOBILE_FUNNEL_BUDGET_MS, PAYMENT_MODE } from '../config';
import { SLOW_4G, throttle, warmRoutes } from '../helpers/network';

test.describe('mobile funnel under throttling', () => {
  test(`a guest books in under ${MOBILE_FUNNEL_BUDGET_MS / 1000}s on Slow 4G`, async ({
    page,
    api,
    seed,
    activityPage,
    checkoutPage,
  }) => {
    const selection = await seed.selection({ quantity: 1 });
    const guest = seed.guest('mobile');

    const activityPath = `/activities/${encodeURIComponent(selection.activity.id)}`;
    const checkoutPath =
      `/checkout?activityId=${encodeURIComponent(selection.activity.id)}` +
      `&rateId=${encodeURIComponent(selection.rate.id)}` +
      `&timeslotId=${encodeURIComponent(selection.slot.timeslotId)}` +
      `&date=${selection.date}&quantity=${selection.quantity}`;

    await warmRoutes(page, ['/', activityPath, checkoutPath]);
    await throttle(page, SLOW_4G, { cpuSlowdown: 4 });

    const started = Date.now();

    await page.goto(activityPath, { waitUntil: 'domcontentloaded' });
    await activityPage.chooseRate(selection.rate.name);
    await activityPage.chooseDate(selection.slot.datetime);
    await activityPage.chooseTime(selection.slot.datetime);
    await activityPage.continueButton().click();
    await page.waitForURL(/\/checkout\?/);

    await checkoutPage.fillAll(selection, guest);
    const orderNumber = await checkoutPage.submitAndConfirm();

    const elapsedMs = Date.now() - started;
    test.info().annotations.push({
      type: 'measurement',
      description: `${SLOW_4G.name} + 4x CPU: activity page → confirmation in ${(elapsedMs / 1000).toFixed(1)}s (budget ${MOBILE_FUNNEL_BUDGET_MS / 1000}s)`,
    });

    // The booking has to be real, not just fast — and "real" means different balances in
    // the two payment modes. Card mode charges online, so the order is paid in full and
    // nothing is owed. Reserve mode ("pay at the marina") takes no card online and leaves
    // the whole total as balance due; asserting a zero balance there would fail a booking
    // that is exactly as real, just unpaid until check-in.
    const order = await api.order(orderNumber);
    if (PAYMENT_MODE === 'reserve') {
      expect(order.balanceDueCents).toBe(order.totalCents);
      expect(order.totalCents).toBeGreaterThan(0);
    } else {
      expect(order.balanceDueCents).toBe(0);
    }

    expect(
      elapsedMs,
      `booking took ${(elapsedMs / 1000).toFixed(1)}s on ${SLOW_4G.name}; the budget is ` +
        `${MOBILE_FUNNEL_BUDGET_MS / 1000}s. Override with E2E_FUNNEL_BUDGET_MS while investigating.`,
    ).toBeLessThan(MOBILE_FUNNEL_BUDGET_MS);
  });

  test('the phone layout has no horizontal scroll and real tap targets', async ({
    page,
    seed,
    activityPage,
  }) => {
    // Two things that make a phone booking flow unusable and that a desktop run cannot
    // see: content wider than the screen, and controls too small to hit with a thumb.
    // 44px is the WCAG 2.5.5 / platform HIG minimum, and the app already builds to it
    // (min-h-[44px] on the calendar toggle, h-11 on the steppers) — so this is a
    // regression guard, not an aspiration.
    const selection = await seed.selection();
    await activityPage.open(selection.activity.id);
    await activityPage.chooseRate(selection.rate.name);
    await activityPage.chooseDate(selection.slot.datetime);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the page must never scroll sideways on a phone').toBeLessThanOrEqual(1);

    for (const control of [
      activityPage.continueButton(),
      page.getByRole('button', { name: 'Increase guests' }),
    ]) {
      const box = await control.boundingBox();
      expect(box, 'the control must be laid out').not.toBeNull();
      expect(box!.height, 'tap targets must be at least 44px tall').toBeGreaterThanOrEqual(44);
    }
  });
});
