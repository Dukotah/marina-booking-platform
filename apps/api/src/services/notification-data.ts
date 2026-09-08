/**
 * Shared, provider-agnostic data + formatting helpers for notifications.
 *
 * Both the email service (notifications.ts, via Resend) and the SMS service
 * (sms.ts, via Twilio) load the same order bundle and derive the same booking
 * facts (activity/date/time/party), so that logic lives here once. Keeping it in
 * its own module also avoids a circular import between the two provider services
 * (notifications.ts calls into sms.ts for reminders; both import from here).
 *
 * Every loader is tenant-scoped: callers pass an operator-scoped Prisma client
 * (`forOperator`) so RLS guarantees no cross-tenant leaks.
 */

import { type TenantClient } from '@marina/database';

// ---------------------------------------------------------------------------
// Result type (shared by every notification channel)
// ---------------------------------------------------------------------------

/** Outcome of a notification attempt. Send functions never throw — they report here. */
export interface NotificationResult {
  sent: boolean;
  /** Provider message id when sent. */
  id?: string;
  /** Why it did not send (skipped / no recipient / provider error). */
  skippedReason?: string;
}

export const skipped = (reason: string): NotificationResult => ({
  sent: false,
  skippedReason: reason,
});

// ---------------------------------------------------------------------------
// Customer-portal URLs (shared by email, SMS, and magic-link flows)
// ---------------------------------------------------------------------------

/** Absolute base URL of the customer portal. Derived from what local dev already
 *  sets (`APP_BASE_DOMAIN=localhost:3000`) so the sandbox link works with no new
 *  env var; `CUSTOMER_PORTAL_URL` overrides it for a real deployment. */
export function customerPortalBaseUrl(): string {
  const explicit = (process.env.CUSTOMER_PORTAL_URL ?? process.env.APP_BASE_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (explicit) return explicit;
  const domain = (process.env.APP_BASE_DOMAIN ?? 'localhost:3000').trim().replace(/\/+$/, '');
  const scheme = /^(localhost|127\.0\.0\.1)/.test(domain) ? 'http' : 'https';
  return `${scheme}://${domain}`;
}

/** Absolute URL of the standalone clause-level waiver signer for one order item. */
export function waiverSignUrl(orderItemId: string): string {
  return `${customerPortalBaseUrl()}/waiver/${encodeURIComponent(orderItemId)}`;
}

// ---------------------------------------------------------------------------
// Branding & formatting
// ---------------------------------------------------------------------------

/** White-label brand fields pulled from an operator row. */
export function brandFromOperator(operator: {
  name_external: string;
  brand_color: string;
  logo_light_url: string | null;
  logo_dark_url: string | null;
}): { brandName: string; brandColor: string; logoUrl?: string } {
  return {
    brandName: operator.name_external,
    brandColor: operator.brand_color,
    logoUrl: operator.logo_light_url ?? operator.logo_dark_url ?? undefined,
  };
}

export function dateLabelFor(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  }).format(date);
}

export function timeLabelFor(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(date);
}

export function fullName(first: string, last: string): string {
  return [first, last].filter(Boolean).join(' ').trim();
}

// ---------------------------------------------------------------------------
// Data loading (tenant-scoped)
// ---------------------------------------------------------------------------

/**
 * Loads an order with everything needed to render booking notifications, scoped
 * to the operator via RLS. Returns null if not found (wrong tenant / deleted).
 */
export async function loadOrderBundle(db: TenantClient, orderId: string) {
  return db.order.findUnique({
    where: { id: orderId },
    include: {
      operator: true,
      customer: true,
      items: {
        include: {
          activity: { include: { location: true } },
          rate: true,
          timeslot: true,
        },
      },
    },
  });
}

export type OrderBundle = NonNullable<Awaited<ReturnType<typeof loadOrderBundle>>>;

/**
 * Pre-arrival sign links for every live item that requires a liability waiver and
 * doesn't have a signed one yet. Empty when nothing is outstanding — the inline
 * checkout waiver (or a prior standalone signature) already flipped
 * `waiver_signed`, so a signed booking never gets nagged.
 */
export function unsignedWaiverLinks(
  order: OrderBundle,
): Array<{ label: string; url: string }> {
  return order.items
    .filter(
      (item) =>
        item.activity.waiver_required && !item.waiver_signed && item.status !== 'CANCELLED',
    )
    .map((item) => ({
      label: item.activity.name_external,
      url: waiverSignUrl(item.id),
    }));
}

/** Derive activity/date/time/party labels from the order's first/primary item. */
export function bookingFacts(order: OrderBundle) {
  const operator = order.operator;
  const timezone =
    order.items[0]?.activity.location?.timezone ?? operator.timezone ?? 'America/Los_Angeles';
  const primary = order.items[0];
  const slotDate = primary?.timeslot.datetime ?? null;
  const partySize = order.items.reduce((sum, item) => sum + item.quantity, 0) || 1;
  const activityName =
    order.items.length > 1
      ? `${primary?.activity.name_external ?? 'Booking'} +${order.items.length - 1} more`
      : primary?.activity.name_external ?? 'Your booking';

  return {
    timezone,
    activityName,
    partySize,
    locationLabel: primary?.activity.location?.name ?? undefined,
    dateLabel: slotDate ? dateLabelFor(slotDate, timezone) : 'See your booking details',
    timeLabel: slotDate ? timeLabelFor(slotDate, timezone) : '',
    slotDate,
  };
}
