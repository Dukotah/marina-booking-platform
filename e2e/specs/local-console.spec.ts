/**
 * The Local Console — the owner's testing surface when the product runs with no
 * external account (docs/LOCAL-FIRST-BUILD.md §4.2).
 *
 * The Phase 0 acceptance test is a sentence: the owner can book, pay, and READ THE
 * CONFIRMATION EMAIL AND SMS IN THE LOCAL CONSOLE, without an account anywhere. That
 * sentence is what this file checks. "The email was sent" is not a claim a log line can
 * settle — the message has to be in the inbox, addressed to the right guest, with this
 * booking's reference in it, and its body has to render.
 *
 * The waits here poll a reloaded page rather than sleeping, because the booking route
 * dispatches notifications without awaiting them (`void sendBookingConfirmation(...)`),
 * so a confirmed booking and a written message are two different moments.
 */
import { expect, test } from '../fixtures/test';
import { adminUrl } from '../config';

test.describe('local console', () => {
  test('the confirmation email arrives in the sandbox inbox and renders', async ({
    seed,
    console: localConsole,
  }) => {
    const { orderNumber, guest, selection } = await seed.booking({ guestLabel: 'email' });

    const row = await localConsole.waitForMessage(orderNumber, 'EMAIL', /Booking confirmation/i);
    await expect(row, 'the confirmation must be addressed to the guest who booked').toContainText(
      guest.email.toLowerCase(),
    );

    // The console renders the REAL template in a sandboxed iframe. Asserting inside it
    // proves the template rendered — not merely that a row was written.
    const body = await localConsole.openEmail(row);
    await expect(body).toContainText(orderNumber);
    await expect(body).toContainText(selection.activity.name);
  });

  test('the confirmation SMS arrives with the booking reference', async ({
    seed,
    console: localConsole,
  }) => {
    // The text only fires when the customer left a phone number, and only when it is a
    // real 10/11-digit number (`toE164` in apps/api/src/services/sms.ts). The fixture's
    // guest always has one, which is what makes this assertable at all.
    const { orderNumber, selection } = await seed.booking({ guestLabel: 'sms' });

    const row = await localConsole.waitForMessage(orderNumber, 'SMS', /Booking confirmation/i);
    const bubble = await localConsole.openSms(row);
    await expect(bubble).toContainText(`Ref ${orderNumber}`);
    await expect(bubble).toContainText(selection.activity.name);
  });

  test('the staff alert goes to the operator, not the guest', async ({
    seed,
    console: localConsole,
  }) => {
    // Two different emails leave on one booking. Confusing them is the kind of bug that
    // sends a guest the operator's internal copy, so the recipients are checked apart.
    const { orderNumber, guest } = await seed.booking({ guestLabel: 'staffmail' });

    const staffRow = await localConsole.waitForMessage(orderNumber, 'EMAIL', /Staff new booking/i);
    await expect(staffRow).not.toContainText(guest.email.toLowerCase());
  });

  test('nothing threw during a normal booking', async ({ seed, console: localConsole }) => {
    // The errors tab is the local twin of Sentry. A booking that "works" while quietly
    // throwing in a background dispatch is the failure mode this catches — the guest
    // sees a confirmation and the operator never gets the alert.
    const { orderNumber } = await seed.booking({ guestLabel: 'errors' });
    await localConsole.waitForMessage(orderNumber, 'EMAIL', /Booking confirmation/i);

    const errors = await localConsole.errorSummaries();
    const recent = errors.filter((line) => !/favicon|ECONNRESET/i.test(line));
    expect(recent, `the sandbox recorded errors:\n${recent.join('\n')}`).toEqual([]);
  });

  test('the console can force the next charge and then stand down', async ({
    console: localConsole,
  }) => {
    // The control itself, without a booking attached: queueing an outcome has to be
    // visible and reversible, or the owner cannot trust what he just armed.
    await localConsole.open('payments');
    await expect(localConsole.nextChargeSummary()).toHaveText('Approves normally');

    await localConsole.queueOutcome('Decline', { note: 'e2e console control' });
    await expect(localConsole.nextChargeSummary()).toContainText('Decline');

    await localConsole.clearQueue();
    await expect(localConsole.nextChargeSummary()).toHaveText('Approves normally');
  });

  test('the console is gated, and says so rather than half-working', async ({ page }) => {
    // The gate is `SANDBOX`: /dev must not exist against real providers, and global
    // setup already proved it DOES exist in local mode. What is checked here is that
    // the page is the real console rather than a stub — the six controls the contract
    // enumerates are all present.
    await page.goto(adminUrl('/dev'), { waitUntil: 'domcontentloaded' });

    for (const tab of ['Inbox', 'Payments', 'Webhooks', 'Clock', 'Errors', 'Reset']) {
      await expect(
        page.getByRole('tab', { name: new RegExp(`^${tab}`) }),
        `the Local Console must offer the ${tab} control`,
      ).toBeVisible();
    }
  });
});
