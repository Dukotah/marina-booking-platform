/**
 * The booking funnel, end to end, the way a guest actually walks it:
 * browse → activity → availability → slot → checkout (waiver + promo) → pay → confirm.
 *
 * This is the spec Phase 0 ships (docs/LOCAL-FIRST-BUILD.md §4.5). It is deliberately
 * the ONLY spec that walks the whole journey through the UI. Everything downstream
 * (payments, self-service, the operator's day) deep-links to the page it is actually
 * about, so a regression in the calendar widget fails this spec and only this spec
 * instead of the entire suite.
 */
import { expect, test } from '../fixtures/test';
import { CHECKOUT_SUBMIT_NAME, PAYMENT_MODE } from '../config';
import { formatUSD, parseUSD, percentDiscountCents } from '../helpers/money';
import { longDateLabel, timeLabel } from '../helpers/datetime';
import { rx } from '../helpers/customer';

test.describe('booking funnel', () => {
  test('a guest browses, books a slot, signs the waiver, uses a promo and pays', async ({
    page,
    api,
    seed,
    catalogPage,
    activityPage,
    checkoutPage,
  }) => {
    const selection = await seed.selection({ quantity: 2, requireWaiver: true });
    const guest = seed.guest('funnel');
    const promo = await seed.promo({ percent: 15, activityIds: [selection.activity.id] });

    // --- Browse ------------------------------------------------------------
    await catalogPage.open();
    await catalogPage.openActivity(selection.activity.name);

    // --- Pick a rate, a date and a time ------------------------------------
    await activityPage.chooseRate(selection.rate.name);
    await activityPage.chooseDate(selection.slot.datetime);
    await activityPage.chooseTime(selection.slot.datetime);
    await activityPage.setGuests(selection.quantity);

    // The widget must not let anyone through until all three choices are made, and the
    // CTA must show the real line total — this is where a pricing bug surfaces first.
    const cta = activityPage.continueButton();
    await expect(cta).toBeEnabled();
    await expect(cta).toHaveText(new RegExp(rx(formatUSD(selection.subtotalCents))));
    await cta.click();
    await page.waitForURL(/\/checkout\?/);

    // --- Checkout ----------------------------------------------------------
    await expect(page.getByText(selection.activity.name).first()).toBeVisible();
    await checkoutPage.fillGuestDetails(guest);
    await checkoutPage.fillDrivers(guest, selection.quantity);

    // The waiver is required for this activity, so the checkbox has to be there.
    const waiver = page.getByRole('checkbox', {
      name: /I have read and agree to the liability waiver/,
    });
    await expect(waiver, 'a waiver-required activity must show the waiver').toBeVisible();
    await checkoutPage.signWaiver(guest);

    // --- Promo -------------------------------------------------------------
    await checkoutPage.applyPromo(promo.code);
    const expectedDiscount = percentDiscountCents(selection.subtotalCents, promo.percent);
    // The breakdown row's value, not a loose text match: the amount has to be the one
    // sitting opposite this promo's label. (The app renders the sign as U+2212, so the
    // assertion is on the amount and leaves the glyph alone.)
    const discountValue = page
      .getByText(`Promo (${promo.code})`)
      .locator('xpath=following-sibling::span[1]');
    await expect(discountValue).toContainText(formatUSD(expectedDiscount));

    // --- Pay ---------------------------------------------------------------
    const orderNumber = await checkoutPage.submitAndConfirm();

    // --- Confirmation, checked against the server, not just the screen ------
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/You're all set!/);
    await expect(page.getByText(selection.activity.name).first()).toBeVisible();
    await expect(page.getByText(longDateLabel(selection.slot.datetime)).first()).toBeVisible();
    await expect(page.getByText(timeLabel(selection.slot.datetime)).first()).toBeVisible();
    await expect(page.getByText(`${selection.quantity} guests in party`)).toBeVisible();

    const order = await api.order(orderNumber);
    expect(order.status).toBe('UPCOMING');
    expect(order.customerEmail).toBe(guest.email.toLowerCase());
    expect(order.subtotalCents).toBe(selection.subtotalCents);
    expect(order.discountCents, 'the promo must be applied server-side, not only in the UI').toBe(
      expectedDiscount,
    );
    // What "completed" settles to depends on the payment mode. Card mode charges online,
    // so nothing is owed and the total is paid. Reserve mode ("pay at the marina") takes
    // no card online: the order is created with the full total as balance due and nothing
    // paid yet. Both are a real, completed booking.
    if (PAYMENT_MODE === 'reserve') {
      expect(order.balanceDueCents, 'reserve mode collects at the marina, so the total is still owed').toBe(
        order.totalCents,
      );
      expect(order.amountPaidCents, 'reserve mode takes no payment online').toBe(0);
    } else {
      expect(order.balanceDueCents, 'a card checkout must leave nothing owing').toBe(0);
      expect(order.amountPaidCents).toBe(order.totalCents);
    }
    expect(order.items).toHaveLength(1);
    expect(order.items[0]!.quantity).toBe(selection.quantity);
  });

  test('the total on screen is the total on the order', async ({
    page,
    api,
    seed,
    checkoutPage,
  }) => {
    // Money is integer cents everywhere; this asserts the number a guest agreed to pay
    // is the number the ledger recorded, with no float drift in between.
    const selection = await seed.selection({ quantity: 1 });
    const guest = seed.guest('total');

    await checkoutPage.openDirect(selection);
    await checkoutPage.fillAll(selection, guest);

    // The total row's LABEL depends on whether the API handed the checkout the operator's
    // fees. With fees it can show the real, final figure and labels it "Total"; without
    // them it shows the pre-fee figure and labels it "Estimated total" with a disclaimer
    // (PriceBreakdown.tsx). Match either, and remember which, because the value they carry
    // is a different number and the ledger assertion below has to compare like with like.
    const estimatedRow = page.getByText('Estimated total');
    const isEstimate = await estimatedRow.isVisible().catch(() => false);
    const totalLabel = isEstimate ? estimatedRow : page.getByText('Total', { exact: true }).first();
    const shown = parseUSD(
      await totalLabel.locator('xpath=following-sibling::span[1]').innerText(),
    );
    expect(shown, 'the checkout must show a total').not.toBeNull();

    const orderNumber = await checkoutPage.submitAndConfirm();
    const order = await api.order(orderNumber);

    // Two truths, one per label. When the figure is an *estimate*, taxes and fees are
    // applied server-side, so the estimate is the pre-tax subtotal (after discount + tip).
    // When it is the real *total*, it already includes them, so it equals the order total.
    if (isEstimate) {
      expect(order.subtotalCents - order.discountCents + order.tipCents).toBe(shown);
    } else {
      expect(order.totalCents).toBe(shown);
    }
    expect(order.totalCents).toBe(
      order.subtotalCents - order.discountCents + order.taxCents + order.processingFeeCents + order.tipCents,
    );
  });

  test('checkout refuses a slot that no longer exists', async ({ page, seed }) => {
    // A stale link or a back-button return must fail to a friendly screen rather than
    // creating an order against a timeslot that is not there.
    const selection = await seed.selection();
    const params = new URLSearchParams({
      activityId: selection.activity.id,
      rateId: selection.rate.id,
      timeslotId: 'timeslot-that-does-not-exist',
      date: selection.date,
      quantity: '1',
    });

    await page.goto(`/checkout?${params.toString()}`, { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /That time is no longer available/,
    );
    // The submit button — whatever the mode calls it — must not exist on the error frame.
    await expect(page.getByRole('button', { name: CHECKOUT_SUBMIT_NAME })).toHaveCount(0);
  });
});
