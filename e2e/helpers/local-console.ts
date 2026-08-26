/**
 * Page object for the Local Console at `/dev` in the admin app
 * (docs/LOCAL-FIRST-BUILD.md §4.2).
 *
 * The console is the owner's stand-in for a Stripe dashboard, an email client and a
 * phone. Anything a spec would otherwise need an external account to observe — did the
 * confirmation actually send, did the charge really take the decline branch — is read
 * from here, through the same screen the owner uses.
 *
 * Two things about the waits in here. Booking notifications are dispatched
 * fire-and-forget (`void sendBookingConfirmation(...)` in apps/api/src/routes/orders.ts),
 * so a message can land a moment after the confirmation page renders; `waitForMessage`
 * reloads the server-rendered page until it appears instead of guessing at a sleep.
 * And the tab strip is client state, so a deep link is written as a hash the tab shell
 * reads on mount.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { adminUrl } from '../config';
import { rx } from './customer';

export type ForcedOutcome = 'Approve' | '3DS challenge' | 'Decline' | 'Time out' | 'Dispute';

export class LocalConsole {
  constructor(private readonly page: Page) {}

  /** Open the console on a given tab. The tab shell restores the tab from the hash. */
  async open(tab: 'inbox' | 'payments' | 'webhooks' | 'clock' | 'errors' | 'reset'): Promise<void> {
    await this.page.goto(adminUrl(`/dev#${tab}`), { waitUntil: 'domcontentloaded' });
    await expect(this.page.getByRole('heading', { name: 'Local Console' })).toBeVisible();
    // The hash is applied in an effect, so the tab may start on Inbox for one frame.
    const target = this.page.getByRole('tab', { name: new RegExp(`^${tab}`, 'i') });
    await expect(target).toHaveAttribute('aria-selected', 'true');
  }

  panel(): Locator {
    return this.page.getByRole('tabpanel');
  }

  // --- Payments -------------------------------------------------------------

  /**
   * Script what the NEXT charge does, then confirm the console says so.
   *
   * The ordering is the entire point of the simulator: the instruction is queued
   * BEFORE checkout, and the production payment path pops it at charge time. A spec
   * that queued nothing is testing the happy path by accident.
   */
  async queueOutcome(outcome: ForcedOutcome, options: { note?: string } = {}): Promise<void> {
    await this.open('payments');
    const card = this.page.getByRole('button', { name: new RegExp(`^${rx(outcome)}\\b`) });
    await card.click();
    await expect(card).toHaveAttribute('aria-pressed', 'true');

    if (options.note) {
      await this.page.getByLabel('Note (optional)').fill(options.note);
    }

    await this.page.getByRole('button', { name: 'Queue this outcome' }).click();
    await expect(this.nextChargeSummary()).toContainText(expectedQueueSummary(outcome), {
      timeout: 30_000,
    });
  }

  /**
   * The "Next charge" headline — "Approves normally" when the queue is empty, otherwise
   * a description of the instruction the simulator will pop. Anchored to the "Next
   * charge" caption above it rather than to its own text, so it can be asserted
   * against BEFORE you know what it should say.
   */
  nextChargeSummary(): Locator {
    return this.panel()
      .getByText('Next charge', { exact: true })
      .locator('xpath=following-sibling::p[1]');
  }

  /** Drop every queued instruction so one spec's decline cannot leak into the next. */
  async clearQueue(): Promise<void> {
    await this.open('payments');
    const clear = this.page.getByRole('button', { name: 'Clear queue' });
    if (await clear.isVisible().catch(() => false)) {
      await clear.click();
      await expect(clear).toBeHidden({ timeout: 30_000 });
    }
    await expect(this.panel().getByText('Approves normally')).toBeVisible();
  }

  /** The attempts table row for one order number. */
  attemptRow(orderNumber: string): Locator {
    return this.panel().getByRole('row').filter({ hasText: orderNumber });
  }

  /**
   * Wait for the attempt against `orderNumber` to reach a terminal state and return
   * what the console shows in the "Ended as" column.
   */
  async attemptStatus(orderNumber: string): Promise<string> {
    const row = await this.waitForAttempt(orderNumber);
    const cells = row.getByRole('cell');
    return ((await cells.nth(5).innerText()) ?? '').trim();
  }

  async waitForAttempt(orderNumber: string, timeoutMs = 30_000): Promise<Locator> {
    await this.open('payments');
    const row = this.attemptRow(orderNumber);
    await expect(async () => {
      if (await row.first().isVisible().catch(() => false)) return;
      await this.page.reload({ waitUntil: 'domcontentloaded' });
      throw new Error(`no payment attempt yet for ${orderNumber}`);
    }).toPass({ timeout: timeoutMs });
    return row.first();
  }

  // --- Inbox ----------------------------------------------------------------

  /** The list button for one message, matched on its order number and kind. */
  messageRow(orderNumber: string, kind: RegExp): Locator {
    return this.panel()
      .getByRole('listitem')
      .filter({ hasText: orderNumber })
      .filter({ hasText: kind })
      .getByRole('button');
  }

  /**
   * Wait for a message to arrive in the sandbox inbox, reloading between checks.
   *
   * Notifications are dispatched without being awaited by the booking route, so
   * "the page rendered" does not mean "the email is written". Polling the server-
   * rendered console is the honest way to observe that — it is the same thing the
   * owner does when he refreshes the tab.
   */
  async waitForMessage(
    orderNumber: string,
    filter: 'ALL' | 'EMAIL' | 'SMS',
    kind: RegExp,
    timeoutMs = 45_000,
  ): Promise<Locator> {
    await this.open('inbox');
    await expect(async () => {
      await this.selectChannel(filter);
      const row = this.messageRow(orderNumber, kind);
      if (await row.first().isVisible().catch(() => false)) return;
      await this.page.reload({ waitUntil: 'domcontentloaded' });
      throw new Error(`no ${filter} message yet for ${orderNumber}`);
    }).toPass({ timeout: timeoutMs, intervals: [1_000, 2_000, 3_000] });
    return this.messageRow(orderNumber, kind).first();
  }

  /** Switch the inbox between All / Email / SMS. Tolerates the tab not being rendered
   *  yet on a page that has just reloaded. */
  private async selectChannel(filter: 'ALL' | 'EMAIL' | 'SMS'): Promise<void> {
    const label = filter === 'ALL' ? 'All' : filter === 'EMAIL' ? 'Email' : 'SMS';
    const button = this.panel().getByRole('button', { name: new RegExp(`^${label}\\s+\\d+$`) });
    if (await button.isVisible().catch(() => false)) await button.click();
  }

  /**
   * Open an email and return a locator inside its rendered preview.
   *
   * The console renders the real template into a sandboxed iframe, so asserting on the
   * body means crossing into that frame — which is exactly right: it proves the
   * template rendered, not merely that a row exists.
   */
  async openEmail(row: Locator): Promise<Locator> {
    await row.click();
    const frame = this.page.frameLocator('iframe[title="Message preview"]');
    const body = frame.locator('body');
    await expect(body).toBeVisible();
    return body;
  }

  /**
   * Open an SMS and return the message bubble.
   *
   * The one class-based selector in the suite. An email preview is identifiable by its
   * iframe title; the SMS bubble carries no role, label or title of its own, and
   * matching it by text would defeat the point (the list row already contains the same
   * text, so the assertion would pass without the preview ever rendering).
   * `whitespace-pre-wrap` is at least semantic — it is there because a text message has
   * newlines — but a `data-testid` on that element in MessageInbox.tsx would be the
   * right fix. Flagged in docs/TESTING.md.
   */
  async openSms(row: Locator): Promise<Locator> {
    await row.click();
    const bubble = this.panel().locator('p.whitespace-pre-wrap');
    await expect(bubble).toBeVisible();
    return bubble;
  }

  // --- Errors ---------------------------------------------------------------

  /** Every error the sandbox recorded, as summary text. Empty when nothing threw. */
  async errorSummaries(): Promise<string[]> {
    await this.open('errors');
    if (await this.panel().getByText('Nothing has thrown').isVisible().catch(() => false)) {
      return [];
    }
    return this.panel().locator('summary').allInnerTexts();
  }
}

/** What the "Next charge" headline should read once an outcome is queued. */
function expectedQueueSummary(outcome: ForcedOutcome): RegExp {
  switch (outcome) {
    case 'Approve':
      return /^Approve/;
    case '3DS challenge':
      return /Raise a 3DS challenge/;
    case 'Decline':
      return /Decline \(/;
    case 'Time out':
      return /Time out/;
    case 'Dispute':
      return /Succeed, then dispute/;
  }
}
