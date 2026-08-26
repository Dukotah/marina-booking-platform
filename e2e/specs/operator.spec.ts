/**
 * The operator's day: a booking has to show up everywhere it should, and the two
 * things staff do most — check somebody in, refund somebody — have to work from the
 * screen, not from a terminal.
 *
 * "Does it run my day?" is the first of the three questions that decide whether an
 * operator switches (docs/LOCAL-FIRST-BUILD.md §2). A booking that appears in reports
 * but not on the manifest is a booking the dock does not know about.
 *
 * These tests need no sign-in: with REQUIRE_CLERK_AUTH off, the admin app resolves a
 * deterministic OWNER context for the seed operator. That is the no-account-anywhere
 * mode the contract requires, not a testing shortcut.
 */
import { expect, test } from '../fixtures/test';
import { formatUSD, parseUSD } from '../helpers/money';
import { isoDate } from '../helpers/datetime';
import type { AdminApp } from '../helpers/admin';

test.describe('operator console', () => {
  test('a new booking appears in orders, calendar and manifest', async ({
    page,
    seed,
    admin,
  }) => {
    const { order, orderNumber, guest, selection } = await seed.booking({ guestLabel: 'ops' });

    // --- Orders -------------------------------------------------------------
    await admin.openOrders(orderNumber);
    const row = page.getByRole('row').filter({ hasText: orderNumber });
    await expect(row).toBeVisible();
    await expect(row).toContainText(guest.fullName);
    await expect(row).toContainText(formatUSD(order.totalCents));
    await expect(row, 'a paid booking must not show a balance').toContainText('Paid');

    // --- Calendar -----------------------------------------------------------
    await admin.openCalendar(selection.slot.datetime);
    await expect(
      admin.calendarEntry(order.id),
      'the week grid must carry a block linking to this order',
    ).toBeVisible();

    // --- Manifest -----------------------------------------------------------
    await admin.openManifest(selection.slot.datetime);
    await admin.useManifestList();
    await expect(admin.manifestRow(orderNumber)).toContainText(selection.activity.name);
    await expect(admin.manifestRow(orderNumber)).toContainText(guest.fullName);
  });

  test('a booking taken today lands in the revenue report', async ({ seed, admin }) => {
    // Revenue attributes by the day the order was placed, so a booking made now must
    // fall inside a window that ends today. Both bounds are explicit — "the last 30
    // days" is not something a test should have to infer from a default.
    const day = isoDate(new Date());

    const before = await grossRevenue(admin, day);
    const { order, orderNumber } = await seed.booking({ guestLabel: 'revenue' });
    const after = await grossRevenue(admin, day);

    /*
     * Greater-or-equal, not equal. The revenue report is a tenant-wide aggregate and
     * another worker may legitimately book against the same operator in the same
     * second, so an exact delta would be a test that fails for a reason that is not a
     * bug. The order's own presence is asserted directly below, which is the part that
     * actually has to be true.
     */
    expect(after - before, "the day's gross must grow by at least this booking").toBeGreaterThanOrEqual(
      order.totalCents,
    );

    // The aggregate moving is weak on its own; the order itself has to be reachable
    // from the same window in the operator's list.
    await admin.openOrders(orderNumber);
    await expect(admin.orderLink(orderNumber)).toBeVisible();
  });

  test('staff check a guest in from the manifest', async ({ api, seed, admin }) => {
    const { orderNumber, selection } = await seed.booking({ guestLabel: 'checkin' });

    await admin.openManifest(selection.slot.datetime);
    const beforeChip = await admin.checkedInChip().innerText();
    await admin.checkIn(orderNumber);

    // The row says checked in. The order item has to agree — an optimistic UI that
    // never persisted is exactly the bug this asserts against.
    const order = await api.order(orderNumber);
    expect(order.items[0]!.status).toBe('CHECKED_IN');

    // And it survives a reload, which is what the dock actually experiences.
    await admin.openManifest(selection.slot.datetime);
    await admin.useManifestList();
    await expect(admin.manifestRow(orderNumber)).toContainText('Checked in');

    // The day's headline count has to move too — that number is what the owner glances
    // at to know how much of his day has actually shown up.
    await expect(admin.checkedInChip()).not.toHaveText(beforeChip);
  });

  test('staff refund a booking in full', async ({ api, seed, admin }) => {
    const { order, orderNumber } = await seed.booking({ guestLabel: 'refund' });
    expect(order.amountPaidCents).toBe(order.totalCents);

    await admin.openOrder(orderNumber);
    await admin.refund({ reason: 'e2e full refund' });

    await expect(admin.actionBanner()).toContainText(/refund/i);

    const refunded = await api.order(orderNumber);
    expect(refunded.amountPaidCents, 'a full refund returns everything').toBe(0);
    expect(refunded.balanceDueCents).toBe(refunded.totalCents);
  });

  test('staff refund part of a booking and the rest stays paid', async ({
    api,
    seed,
    admin,
  }) => {
    const { order, orderNumber } = await seed.booking({ guestLabel: 'partial' });
    // Half, rounded to whole cents — money is integer cents, so a partial refund of
    // "half" has to be a number the ledger can actually hold.
    const refundCents = Math.floor(order.totalCents / 2);
    test.skip(refundCents < 1, 'this booking is too cheap to split a refund');

    await admin.openOrder(orderNumber);
    await admin.refund({ amountCents: refundCents, reason: 'e2e partial refund' });

    const after = await api.order(orderNumber);
    expect(after.amountPaidCents).toBe(order.totalCents - refundCents);
    expect(after.balanceDueCents).toBe(refundCents);
  });
});

/** Gross revenue, in integer cents, for one day's revenue report. */
async function grossRevenue(admin: AdminApp, day: string): Promise<number> {
  await admin.openRevenue(day, day);
  const text = await admin.kpiCard('Gross revenue').innerText();
  const cents = parseUSD(text);
  expect(cents, `could not read gross revenue from "${text}"`).not.toBeNull();
  return cents as number;
}
