/**
 * Payment outcomes, driven through the Local Console's simulator.
 *
 * The shape of every test here is the same and it is the point of the whole sandbox:
 * queue an instruction in the console FIRST, then walk the real checkout, and watch the
 * production payment code take that branch for real. Nothing is stubbed in the browser;
 * the only thing that changed is what the processor decided to do
 * (docs/LOCAL-FIRST-BUILD.md §4.1, §5).
 *
 * Each test clears the queue when it finishes. A leftover "decline" is not a cosmetic
 * problem — it is the next test's card being declined for no reason.
 */
import { expect, test } from '../fixtures/test';

test.describe('payment outcomes', () => {
  test.afterEach(async ({ console: localConsole }) => {
    await localConsole.clearQueue();
  });

  test('a 3DS challenge is completed and the booking confirms', async ({
    page,
    api,
    seed,
    checkoutPage,
    console: localConsole,
  }) => {
    test.info().annotations.push({
      type: 'contract',
      description:
        'LOCAL-FIRST-BUILD §5: "3DS/SCA challenge handled properly (today anything not succeeded is a decline)."',
    });

    const selection = await seed.selection();
    const guest = seed.guest('threeds');

    await localConsole.queueOutcome('3DS challenge', { note: 'e2e 3DS' });

    await checkoutPage.openDirect(selection);
    await checkoutPage.fillAll(selection, guest);
    await checkoutPage.submit();

    // The bank has asked for a second factor. The guest must be shown an authentication
    // step — NOT a decline, and NOT a spinner that never resolves. This is the exact
    // regression the contract calls out.
    const challenge = page.getByRole('button', { name: /Authenticate|Verify|Confirm your card/i });
    await expect(
      challenge,
      'a REQUIRES_ACTION result must offer the guest a way to authenticate',
    ).toBeVisible({ timeout: 60_000 });
    // Asserted as an absence on the page, not as a negated text match on the alert:
    // the alert element may not exist at all in this state, and "there is no element"
    // is not the same claim as "the element does not say declined".
    await expect(
      page.getByText(/declined/i),
      'a challenge is not a decline and must never be reported as one',
    ).toHaveCount(0);

    await challenge.click();

    await page.waitForURL(/\/confirmation\?/, { timeout: 60_000 });
    const orderNumber = new URL(page.url()).searchParams.get('order') as string;
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/You're all set!/);

    // The ledger has to agree: challenged then authorised is a paid booking.
    const order = await api.order(orderNumber);
    expect(order.status).toBe('UPCOMING');
    expect(order.balanceDueCents).toBe(0);
    expect(order.amountPaidCents).toBe(order.totalCents);

    // And the console must show what actually happened, not what was asked for: the
    // attempt was ASKED for a challenge and ENDED as a success. Those two columns
    // diverging is the whole reason the sandbox records them separately.
    expect(await localConsole.attemptStatus(orderNumber)).toMatch(/SUCCEEDED/i);
  });

  test('a decline shows a clean retry and leaves no half-created order', async ({
    page,
    api,
    seed,
    checkoutPage,
    console: localConsole,
  }) => {
    const selection = await seed.selection();
    const guest = seed.guest('decline');

    await localConsole.queueOutcome('Decline', { note: 'e2e decline' });

    await checkoutPage.openDirect(selection);
    await checkoutPage.fillAll(selection, guest);
    await checkoutPage.submit();

    // 1. The guest is told, in words, and is still on checkout with their details.
    await expect(checkoutPage.alert()).toContainText(/declined|different card/i, {
      timeout: 60_000,
    });
    await expect(page).toHaveURL(/\/checkout\?/);
    await expect(page.getByLabel('Email', { exact: false }).first()).toHaveValue(guest.email);

    // 2. The button is usable again. A retry that needs a page reload is not a retry.
    await expect(checkoutPage.submitButton()).toBeEnabled();

    // 3. Nothing was left behind. A declined card must not leave an unpaid order sitting
    //    in the operator's list holding capacity — that is the "half-created order" the
    //    contract names, and it is the whole reason this test exists.
    const orders = await api.ordersForEmail(guest.email);
    expect(
      orders,
      'a declined payment must not leave an order behind for this guest',
    ).toHaveLength(0);

    // 4. The attempt itself is recorded, with the reason. Failing silently is worse than
    //    failing: the owner has to be able to see why a guest could not pay.
    await localConsole.open('payments');
    const rows = localConsole.panel().getByRole('row').filter({ hasText: /card_declined/ });
    await expect(rows.first()).toBeVisible();
  });

  test('a retry after a decline succeeds and books once', async ({
    api,
    seed,
    checkoutPage,
    console: localConsole,
  }) => {
    const selection = await seed.selection();
    const guest = seed.guest('retry');

    await localConsole.queueOutcome('Decline', { note: 'e2e retry — first attempt' });

    await checkoutPage.openDirect(selection);
    await checkoutPage.fillAll(selection, guest);
    await checkoutPage.submit();
    await expect(checkoutPage.alert()).toContainText(/declined|different card/i, {
      timeout: 60_000,
    });

    // Second try on a good card, from the same page, without re-entering anything.
    const orderNumber = await checkoutPage.submitAndConfirm();

    const orders = await api.ordersForEmail(guest.email);
    expect(orders.map((o) => o.orderNumber), 'exactly one order, from the successful attempt').toEqual([
      orderNumber,
    ]);
    const order = await api.order(orderNumber);
    expect(order.balanceDueCents).toBe(0);
  });

  test('a network timeout does not silently take the money', async ({
    page,
    seed,
    checkoutPage,
    console: localConsole,
  }) => {
    // The nastiest case: the connection dies before the processor answers, so nobody
    // knows whether the card was charged. What must NOT happen is a confirmation page.
    const selection = await seed.selection();
    const guest = seed.guest('timeout');

    await localConsole.queueOutcome('Time out', { note: 'e2e timeout' });

    await checkoutPage.openDirect(selection);
    await checkoutPage.fillAll(selection, guest);
    await checkoutPage.submit();

    await expect(checkoutPage.alert()).toBeVisible({ timeout: 90_000 });
    await expect(page, 'an unresolved charge must never render a confirmation').not.toHaveURL(
      /\/confirmation/,
    );
  });

  test.describe('double submit', () => {
    test('the checkout button cannot fire twice', async ({ page, api, seed, checkoutPage }) => {
      const selection = await seed.selection();
      const guest = seed.guest('dblui');

      /*
       * Hold the submit open for a few seconds so the in-flight window is a fact rather
       * than a race. Without this the assertion below is only true if the round trip
       * happens to be slower than the assertion — which is the definition of a flaky
       * test. The delay is added to the transport, not to the app: the server action
       * still runs, in full, exactly once.
       */
      await page.route('**/checkout**', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        await route.continue();
      });

      await checkoutPage.openDirect(selection);
      await checkoutPage.fillAll(selection, guest);
      await checkoutPage.submit();

      // The first guard against a double charge is in the browser: while the request is
      // in flight the control is disabled, so an impatient double-tap on a slow
      // connection cannot fire a second booking. `trial: true` asks whether a click
      // would be accepted without sending one.
      await expect(checkoutPage.submitButton()).toBeDisabled();
      await expect(
        checkoutPage.submitButton().click({ trial: true, timeout: 2_000 }),
        'a second tap while the first submit is in flight must be refused',
      ).rejects.toThrow();

      await page.waitForURL(/\/confirmation\?/, { timeout: 90_000 });
      const orders = await api.ordersForEmail(guest.email);
      expect(orders, 'one tap, one booking').toHaveLength(1);
    });

    test('two identical submits with one idempotency key produce one order', async ({
      api,
      seed,
    }) => {
      test.info().annotations.push({
        type: 'contract',
        description:
          'LOCAL-FIRST-BUILD §5: "Idempotency keys so a double-submit or a flaky connection cannot double-charge."',
      });

      // The browser guard above is necessary and not sufficient: a retried request from
      // a flaky connection never touches the button. This drives the same public
      // endpoint the checkout server action uses, twice, concurrently, with one key —
      // which is exactly what a retry looks like from the server's side.
      const selection = await seed.selection();
      const guest = seed.guest('dblapi');
      const idempotencyKey = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const body = {
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
        participants: [{ driver_name: guest.fullName }],
        idempotencyKey,
      };

      const [first, second] = await Promise.all([
        api.rawPost('/api/orders', body),
        api.rawPost('/api/orders', body),
      ]);

      const created = [first, second].filter((r) => r.ok());
      expect(
        created.length,
        'at least one of two concurrent identical submits must succeed',
      ).toBeGreaterThan(0);

      const orders = await api.ordersForEmail(guest.email);
      expect(
        orders.map((o) => o.orderNumber),
        'a replayed submit must resolve to the SAME order, never a second one',
      ).toHaveLength(1);

      // And the capacity ledger must agree — one order means one seat count taken.
      const day = await api.availability(selection.activity.id, selection.date);
      const slot = day.slots.find((s) => s.timeslotId === selection.slot.timeslotId);
      expect(slot?.capacityBooked).toBe(selection.slot.capacityBooked + selection.quantity);
    });

    test('charging one order twice with one key does not double-charge', async ({ api, seed }) => {
      const { order } = await seed.booking({ pay: false });
      expect(order.balanceDueCents).toBeGreaterThan(0);

      const idempotencyKey = `e2e-charge-${order.id}`;
      const [first, second] = await Promise.all([
        api.rawPost('/api/payments/charge', {
          orderId: order.id,
          sourceId: 'dev_pm_e2e',
          idempotencyKey,
        }),
        api.rawPost('/api/payments/charge', {
          orderId: order.id,
          sourceId: 'dev_pm_e2e',
          idempotencyKey,
        }),
      ]);

      expect([first, second].some((r) => r.ok()), 'one charge must go through').toBe(true);

      const settled = await api.order(order.orderNumber);
      expect(settled.amountPaidCents, 'the guest is charged the total exactly once').toBe(
        settled.totalCents,
      );
      expect(settled.balanceDueCents).toBe(0);
    });
  });
});

