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

/**
 * The refund decision for a cancelled order, read back off the ORDER_CANCELLED
 * OrderEvent that `cancelBooking` stamps (the single row that explains what
 * happened to the money). Shaped for the cancellation notification: every field
 * is defensively coerced so a hand-edited / legacy event never throws inside a
 * send path. Returns null when the order has no cancel event.
 */
export interface CancellationFacts {
  reason: string | null;
  refundCents: number;
  cardRefundCents: number;
  giftRefundCents: number;
  feeCents: number;
}

function toCents(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Load the money/refund facts for a cancelled order from its ORDER_CANCELLED
 * event. Tenant-scoped; returns null if the order was never cancelled (or the
 * event is missing), so the caller can skip cleanly.
 */
export async function loadCancellationFacts(
  db: TenantClient,
  orderId: string,
): Promise<CancellationFacts | null> {
  const event = await db.orderEvent.findFirst({
    where: { order_id: orderId, type: 'ORDER_CANCELLED' },
    orderBy: { created_at: 'desc' },
    select: { metadata: true },
  });
  if (!event) return null;
  const meta = (event.metadata ?? {}) as Record<string, unknown>;
  return {
    reason: typeof meta.reason === 'string' && meta.reason.trim() ? meta.reason.trim() : null,
    refundCents: toCents(meta.refundCents),
    cardRefundCents: toCents(meta.cardRefundCents),
    giftRefundCents: toCents(meta.giftRefundCents),
    feeCents: toCents(meta.feeCents),
  };
}

/**
 * A masked label for the card the order's refund went back to, e.g.
 * "Visa ending 4242", read off the most recent refundable card payment. Returns
 * undefined when the order has no card payment with brand/last-four on file.
 */
export async function refundedCardLabel(
  db: TenantClient,
  orderId: string,
): Promise<string | undefined> {
  const payment = await db.payment.findFirst({
    where: { order_id: orderId, method: 'CARD', card_brand: { not: null }, card_last_four: { not: null } },
    orderBy: { processed_at: 'desc' },
    select: { card_brand: true, card_last_four: true },
  });
  if (payment?.card_brand && payment.card_last_four) {
    return `${payment.card_brand} ending ${payment.card_last_four}`;
  }
  return undefined;
}

/**
 * The latest moment every non-cancelled item on the order has finished — slot
 * start + that item's rate duration, taking the max across items. Returns null
 * when the order has no live, scheduled item (nothing to be "post-trip" about).
 * Used by the post-trip review sweep to know a trip has actually ended.
 */
export function tripEnd(order: OrderBundle): Date | null {
  let latest: number | null = null;
  for (const item of order.items) {
    if (item.status === 'CANCELLED') continue;
    const start = item.timeslot?.datetime;
    if (!start) continue;
    const durationMs = (item.rate?.duration_minutes ?? 0) * 60_000;
    const end = start.getTime() + durationMs;
    if (latest === null || end > latest) latest = end;
  }
  return latest === null ? null : new Date(latest);
}

/**
 * Format a raw question answer (string / string[] / boolean / number) into a
 * human display string for the confirmation email. CHECKBOX answers come through
 * as booleans; SELECT-multi as arrays; DATE/PHONE/NUMBER as strings/numbers.
 */
export function formatAnswer(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  if (Array.isArray(raw)) return raw.map((v) => String(v)).filter(Boolean).join(', ');
  return String(raw).trim();
}

/** One confirmation-visible question answer: label + formatted value. */
export interface ConfirmationDetail {
  label: string;
  value: string;
}

/**
 * Build the list of custom-question answers to echo in the booking confirmation.
 * Reads the order's `question_answers` JSON (keyed by CustomerQuestion id) and
 * joins it to the operator's questions flagged `show_in_confirmation`, preserving
 * the operator's sort order. Tenant-scoped via the passed client (RLS). Returns an
 * empty array when nothing is flagged or answered — the email then renders no
 * "Your details" block. Never throws; a malformed answers blob yields [].
 */
export async function loadConfirmationDetails(
  db: TenantClient,
  order: OrderBundle,
): Promise<ConfirmationDetail[]> {
  const answers = (order.question_answers ?? null) as Record<string, unknown> | null;
  if (!answers || typeof answers !== 'object') return [];
  const ids = Object.keys(answers);
  if (ids.length === 0) return [];

  const questions = await db.customerQuestion.findMany({
    where: { id: { in: ids }, show_in_confirmation: true },
    orderBy: [{ sort_index: 'asc' }, { created_at: 'asc' }],
    select: { id: true, label: true },
  });

  const details: ConfirmationDetail[] = [];
  for (const q of questions) {
    const value = formatAnswer(answers[q.id]);
    if (value) details.push({ label: q.label, value });
  }
  return details;
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
