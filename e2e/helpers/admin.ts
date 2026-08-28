/**
 * Page objects for the operator console (apps/admin, :3002).
 *
 * No sign-in step: with REQUIRE_CLERK_AUTH off, apps/admin/lib/session.ts resolves a
 * deterministic OWNER context for the seed operator, which is precisely the
 * no-account-anywhere mode the contract requires (docs/LOCAL-FIRST-BUILD.md §0). If
 * the suite is ever pointed at a Clerk-enforcing deployment these helpers will land on
 * /sign-in and fail with a visible redirect rather than a mystery timeout.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { adminUrl } from '../config';
import { isoDate } from './datetime';

export class AdminApp {
  constructor(private readonly page: Page) {}

  /** Navigate and assert we landed on the intended page, not on a sign-in redirect. */
  private async go(path: string, heading: string | RegExp): Promise<void> {
    await this.page.goto(adminUrl(path), { waitUntil: 'domcontentloaded' });
    await expect(
      this.page.getByRole('heading', { level: 1, name: heading }),
      `expected the admin "${String(heading)}" page — a sign-in screen here means Clerk enforcement is on`,
    ).toBeVisible();
  }

  // --- Orders ---------------------------------------------------------------

  /** Orders list, optionally pre-filtered by the search box's query param. */
  async openOrders(search?: string): Promise<void> {
    const qs = search ? `?search=${encodeURIComponent(search)}` : '';
    await this.go(`/orders${qs}`, 'Orders');
  }

  orderLink(orderNumber: string): Locator {
    return this.page.getByRole('link', { name: orderNumber, exact: true });
  }

  /** Order detail. The page title IS the order number. */
  async openOrder(orderNumber: string): Promise<void> {
    await this.openOrders(orderNumber);
    await expect(this.orderLink(orderNumber)).toBeVisible();
    await this.orderLink(orderNumber).click();
    await expect(this.page.getByRole('heading', { level: 1, name: orderNumber })).toBeVisible();
  }

  /**
   * Open a control whose handler only exists after the client bundle has attached.
   *
   * The order page is server-rendered, so a button is painted, enabled and clickable a
   * beat before React hydrates it — and a click landing in that window is swallowed
   * with no error and no visual change. Nothing already awaited can see the difference:
   * `openOrder` waits on the H1, which is in the server HTML too. The tell is that this
   * only bit when the route was already warm, i.e. when the page arrived fast enough to
   * beat its own bundle.
   *
   * So the click is repeated until the thing it reveals is actually on screen. No
   * assertion is softened by this: a control that is missing, disabled, or wired to
   * nothing still fails here, and the guard means a retry can never toggle a panel that
   * the previous click already opened back shut.
   */
  private async openControl(control: Locator, reveals: Locator): Promise<void> {
    await expect(async () => {
      if (await reveals.isVisible().catch(() => false)) return;
      await control.click();
      await expect(reveals).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000, intervals: [250, 500, 1_000] });
  }

  /**
   * Refund a payment on the open order detail page.
   *
   * `amountCents` omitted means the full refundable balance (the panel's default);
   * supplying it drives the partial-refund path instead.
   */
  async refund(options: { amountCents?: number; reason?: string } = {}): Promise<void> {
    await this.openControl(
      this.page.getByRole('button', { name: 'Refund', exact: true }),
      this.page.getByText('Issue a refund'),
    );

    if (options.amountCents !== undefined) {
      await this.page.getByRole('radio', { name: 'Partial' }).check();
      await this.page.getByLabel('Amount (USD)').fill((options.amountCents / 100).toFixed(2));
    }
    if (options.reason) {
      await this.page.getByLabel('Reason (optional)').fill(options.reason);
    }

    await this.page.getByRole('button', { name: /^Refund \$/ }).click();
    // The action banner is a live region; waiting on it is what proves the server
    // action came back, rather than waiting on a re-render that may not change.
    await expect(this.page.getByRole('status')).toBeVisible({ timeout: 30_000 });
  }

  /** Text of the most recent action banner on the order page. */
  actionBanner(): Locator {
    return this.page.getByRole('status');
  }

  // --- Manifest -------------------------------------------------------------

  /** The day manifest for the given instant's calendar day. */
  async openManifest(datetime: string): Promise<void> {
    await this.go(`/manifest?date=${isoDate(datetime)}`, 'Manifest');
  }

  /** The list-view row for one booking. */
  manifestRow(orderNumber: string): Locator {
    return this.page.getByRole('row').filter({ hasText: orderNumber });
  }

  /** Switch the manifest to its list view (the Gantt is the default on wide screens). */
  async useManifestList(): Promise<void> {
    const listTab = this.page.getByRole('button', { name: 'List', exact: true });
    if (await listTab.isVisible().catch(() => false)) await listTab.click();
  }

  /** One-tap check-in from the manifest list, waiting for the row to reflect it. */
  async checkIn(orderNumber: string): Promise<void> {
    await this.useManifestList();
    const row = this.manifestRow(orderNumber);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Check in' }).click();
    // The optimistic update swaps the action for "Undo" — that is the row telling us
    // the server action resolved, and it is what the dock staff would see.
    await expect(row.getByRole('button', { name: 'Undo' })).toBeVisible({ timeout: 30_000 });
  }

  /**
   * The "Checked in" summary chip's value, e.g. "3/12".
   *
   * `.first()` because "Checked in" is also the status badge on every checked-in row;
   * the summary chips render above the list, so the first occurrence is the chip.
   */
  checkedInChip(): Locator {
    return this.page
      .getByText('Checked in', { exact: true })
      .first()
      .locator('xpath=following-sibling::div[1]');
  }

  // --- Calendar -------------------------------------------------------------

  /** The week calendar containing the given instant. */
  async openCalendar(datetime: string): Promise<void> {
    await this.go(`/calendar?date=${isoDate(datetime)}`, 'Calendar');
  }

  /** A calendar block deep-links to its order, so the link href is the stable handle. */
  calendarEntry(orderId: string): Locator {
    return this.page.locator(`a[href="/orders/${orderId}"]`);
  }

  // --- Reports --------------------------------------------------------------

  /** The revenue report over an explicit window, so "today" is never ambiguous. */
  async openRevenue(from: string, to: string): Promise<void> {
    await this.go(`/reports?report=revenue&from=${from}&to=${to}`, 'Reports');
    await expect(this.page.getByText('Gross revenue')).toBeVisible();
  }

  /**
   * A KPI tile, located by its label. The whole card is returned rather than just the
   * number, because the label and the value are cousins in the DOM (the label shares a
   * flex row with the icon) and a card asserted with `toContainText` cannot silently
   * read the wrong tile's figure.
   */
  kpiCard(label: string): Locator {
    return this.page.getByText(label, { exact: true }).locator('xpath=ancestor::div[2]');
  }
}
