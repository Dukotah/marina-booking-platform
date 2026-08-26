/**
 * Page objects for the customer booking portal (apps/web, :3000).
 *
 * Every locator here is built from an accessible role, label or visible text — never a
 * Tailwind class. That is not style policing: the class strings in this app are
 * regenerated whenever the design moves, so a `.rounded-2xl` selector is a test that
 * breaks for no reason, while `getByRole('radio', { name: /9:30 AM/ })` breaks only
 * when the thing a guest actually interacts with breaks.
 *
 * Nothing here sleeps. Waits are on state: a locator being visible, a URL matching, a
 * network response arriving.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import type { BookingSelection, Guest } from '../fixtures/booking-data';
import { dayLabel, timeLabel } from './datetime';

/** Escape a literal string for use inside a RegExp. */
export function rx(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export class CatalogPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await this.page.goto('/', { waitUntil: 'domcontentloaded' });
    // The hero renders the operator's name as the <h1>; its presence is the signal that
    // the tenant resolved and the catalog request came back.
    await expect(this.page.getByRole('heading', { level: 1 })).toBeVisible();
  }

  searchBox(): Locator {
    return this.page.getByRole('searchbox', { name: 'Search activities' });
  }

  /** The card link for one activity, matched on its heading text. */
  card(activityName: string): Locator {
    return this.page.getByRole('link').filter({ has: this.page.getByRole('heading', { name: activityName, exact: true }) });
  }

  /** Search for an activity by name and open its detail page. */
  async openActivity(activityName: string): Promise<void> {
    await this.searchBox().fill(activityName);
    const card = this.card(activityName).first();
    await expect(card).toBeVisible();
    await card.click();
    await this.page.waitForURL(/\/activities\//);
  }
}

// ---------------------------------------------------------------------------
// Activity detail + booking widget
// ---------------------------------------------------------------------------

export class ActivityPage {
  constructor(private readonly page: Page) {}

  async open(activityId: string): Promise<void> {
    await this.page.goto(`/activities/${encodeURIComponent(activityId)}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(this.rateGroup()).toBeVisible();
  }

  rateGroup(): Locator {
    return this.page.getByRole('radiogroup', { name: 'Choose a rate' });
  }

  dateStrip(): Locator {
    // Exact, because the expandable month grid is a second radiogroup whose label
    // ("Choose a date by month") starts with the same words.
    return this.page.getByRole('radiogroup', { name: 'Choose a date', exact: true });
  }

  timeGroup(): Locator {
    return this.page.getByRole('radiogroup', { name: 'Choose a time' });
  }

  continueButton(): Locator {
    return this.page.getByRole('button', { name: /Continue to checkout/ });
  }

  async chooseRate(rateName: string): Promise<void> {
    const option = this.rateGroup().getByRole('radio', { name: new RegExp(rx(rateName)) });
    await option.click();
    await expect(option).toHaveAttribute('aria-checked', 'true');
  }

  /**
   * Pick a calendar day from the 14-day strip. The strip renders a skeleton until the
   * range request resolves, so this waits for the day to become enabled rather than
   * clicking into a disabled button.
   */
  async chooseDate(slotDatetime: string): Promise<void> {
    const label = new RegExp(`^${rx(dayLabel(slotDatetime))}\\b`);
    const day = this.dateStrip().getByRole('radio', { name: label });
    await expect(day).toBeEnabled();
    await day.click();
    await expect(day).toHaveAttribute('aria-checked', 'true');
  }

  /** Pick a time chip. Its accessible name is the time followed by the spots-left line. */
  async chooseTime(slotDatetime: string): Promise<void> {
    const chip = this.timeGroup().getByRole('radio', {
      name: new RegExp(`^${rx(timeLabel(slotDatetime))}\\b`),
    });
    await expect(chip).toBeEnabled();
    await chip.click();
    await expect(chip).toHaveAttribute('aria-checked', 'true');
  }

  /** Raise the party size to `quantity` using the stepper. */
  async setGuests(quantity: number): Promise<void> {
    const increase = this.page.getByRole('button', { name: 'Increase guests' });
    for (let i = 1; i < quantity; i++) {
      if (await increase.isDisabled()) break;
      await increase.click();
    }
  }
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export class CheckoutPage {
  constructor(private readonly page: Page) {}

  /**
   * Jump straight to a resolved selection.
   *
   * The checkout page validates every param against live availability, so a deep link
   * is not a shortcut past any real check — it is the same page the widget produces.
   * Specs that are not testing the browse-and-pick journey use this so a change to the
   * calendar cannot fail a payment test.
   */
  async openDirect(selection: BookingSelection): Promise<void> {
    const params = new URLSearchParams({
      activityId: selection.activity.id,
      rateId: selection.rate.id,
      timeslotId: selection.slot.timeslotId,
      date: selection.date,
      quantity: String(selection.quantity),
    });
    await this.page.goto(`/checkout?${params.toString()}`, { waitUntil: 'domcontentloaded' });
    await expect(this.submitButton()).toBeVisible();
  }

  submitButton(): Locator {
    return this.page.getByRole('button', { name: /Complete booking|Processing/ });
  }

  /** The live region the submit pipeline writes recoverable failures into. */
  alert(): Locator {
    return this.page.getByRole('alert');
  }

  async fillGuestDetails(guest: Guest): Promise<void> {
    // A remembered guest (localStorage "book again") would prefill these. A fresh
    // context has none, but a spec that reuses one would, and the banner's values must
    // never quietly outrank the spec's.
    const notYou = this.page.getByRole('button', { name: 'Not you?' });
    if (await notYou.isVisible().catch(() => false)) await notYou.click();
    await this.page.getByLabel('First name', { exact: false }).fill(guest.firstName);
    await this.page.getByLabel('Last name', { exact: false }).fill(guest.lastName);
    await this.page.getByLabel('Email', { exact: false }).first().fill(guest.email);
    await this.page.getByLabel('Phone', { exact: false }).fill(guest.phone);
  }

  /** Driver rows are `participant-<i>-name`, one per guest. */
  async fillDrivers(guest: Guest, quantity: number): Promise<void> {
    for (let i = 0; i < quantity; i++) {
      const name = i === 0 ? guest.fullName : `${guest.firstName} Guest${i + 1}`;
      await this.page.locator(`#participant-${i}-name`).fill(name);
    }
  }

  /** Tick the waiver and type the signature. No-op when the activity needs no waiver. */
  async signWaiver(guest: Guest): Promise<void> {
    const checkbox = this.page.getByRole('checkbox', {
      name: /I have read and agree to the liability waiver/,
    });
    if (!(await checkbox.isVisible().catch(() => false))) return;
    await checkbox.check();
    await this.page.getByLabel(/Signature/).fill(guest.fullName);
  }

  /** Enter a promo code and wait for it to be accepted (or report why it was not). */
  async applyPromo(code: string): Promise<void> {
    await this.page.getByLabel('Promo code').fill(code);
    await this.page.getByRole('button', { name: 'Apply', exact: true }).click();
    // The applied state replaces the input with a confirmation chip; waiting on that is
    // what proves the API round trip landed, rather than a timer.
    await expect(this.page.getByText(new RegExp(`Promo\\s+${rx(code)}\\s+applied`, 'i'))).toBeVisible();
  }

  /** Fill everything a guest must supply, without submitting. */
  async fillAll(selection: BookingSelection, guest: Guest): Promise<void> {
    await this.fillGuestDetails(guest);
    await this.fillDrivers(guest, selection.quantity);
    await this.signWaiver(guest);
  }

  async submit(): Promise<void> {
    await this.submitButton().click();
  }

  /** Submit and wait for the confirmation page, returning the order number. */
  async submitAndConfirm(): Promise<string> {
    await this.submit();
    await this.page.waitForURL(/\/confirmation\?/, { timeout: 60_000 });
    return new ConfirmationPage(this.page).orderNumber();
  }
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export class ConfirmationPage {
  constructor(private readonly page: Page) {}

  heading(): Locator {
    return this.page.getByRole('heading', { level: 1 });
  }

  /**
   * The confirmed order number.
   *
   * Taken from the `?order=` param the checkout redirect wrote — that is the value the
   * product itself is asserting, and it cannot be confused with any other run of
   * capitals on the page. The success heading and the number's visible presence are
   * both asserted, so this still fails if the page rendered a not-found state.
   */
  async orderNumber(): Promise<string> {
    await expect(this.heading()).toHaveText(/You're all set!/);
    const fromUrl = new URL(this.page.url()).searchParams.get('order');
    expect(fromUrl, 'confirmation URL should carry the order number').toBeTruthy();
    const orderNumber = (fromUrl as string).trim();
    await expect(this.page.getByText(orderNumber, { exact: true }).first()).toBeVisible();
    return orderNumber;
  }
}

// ---------------------------------------------------------------------------
// Self-service booking lookup
// ---------------------------------------------------------------------------

export class BookingLookupPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await this.page.goto('/account', { waitUntil: 'domcontentloaded' });
    await expect(this.page.getByRole('heading', { name: 'My Bookings' })).toBeVisible();
  }

  /** Look a booking up with its number + the booking email, landing on the manage view. */
  async lookup(orderNumber: string, email: string): Promise<void> {
    await this.page.getByLabel('Confirmation number').fill(orderNumber);
    await this.page.getByLabel('Email', { exact: false }).fill(email);
    await this.page.getByRole('button', { name: 'Find my booking' }).click();
    await this.page.waitForURL(/\/account\/bookings\?/, { timeout: 60_000 });
    await expect(
      this.page.getByRole('heading', { name: new RegExp(`Reservation ${rx(orderNumber)}`) }),
    ).toBeVisible();
  }

  /** Direct link into the manage view, for specs not testing the lookup form itself. */
  async openBooking(orderNumber: string, email: string): Promise<void> {
    const qs = new URLSearchParams({ order: orderNumber, email });
    await this.page.goto(`/account/bookings?${qs.toString()}`, { waitUntil: 'domcontentloaded' });
    await expect(
      this.page.getByRole('heading', { name: new RegExp(`Reservation ${rx(orderNumber)}`) }),
    ).toBeVisible();
  }
}

/** The reschedule dialog opened from the manage panel. */
export class ReschedulePanel {
  constructor(private readonly page: Page) {}

  dialog(): Locator {
    return this.page.getByRole('dialog');
  }

  async open(): Promise<void> {
    await this.page.getByRole('button', { name: /^Reschedule/ }).click();
    await expect(this.dialog()).toBeVisible();
  }

  /** Multi-item orders ask which booking to move first; single-item ones skip it. */
  async chooseItemIfAsked(activityName: string): Promise<void> {
    const picker = this.page.getByRole('heading', {
      name: 'Which booking would you like to change?',
    });
    if (await picker.isVisible().catch(() => false)) {
      await this.dialog().getByRole('button', { name: new RegExp(rx(activityName)) }).first().click();
    }
  }

  async chooseDate(datetime: string): Promise<void> {
    const day = this.dialog()
      .getByRole('radiogroup', { name: 'Choose a date', exact: true })
      .getByRole('radio', { name: new RegExp(`^${rx(dayLabel(datetime))}\\b`) });
    await expect(day).toBeEnabled();
    await day.click();
  }

  async chooseTime(datetime: string): Promise<void> {
    const chip = this.dialog()
      .getByRole('radiogroup', { name: 'Choose a time' })
      .getByRole('radio', { name: new RegExp(`^${rx(timeLabel(datetime))}\\b`) });
    await expect(chip).toBeEnabled();
    await chip.click();
  }

  async confirm(): Promise<void> {
    const button = this.page.getByRole('button', { name: 'Confirm new time' });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(this.page.getByRole('heading', { name: 'Reservation updated' })).toBeVisible({
      timeout: 30_000,
    });
  }
}
