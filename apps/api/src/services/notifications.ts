/**
 * Notifications service — transactional email via Resend + @marina/emails.
 *
 * Every function is tenant-scoped: callers pass the operator id and the entity id
 * (order / payment), and this service loads the full record through the
 * tenant-scoped Prisma client (`forOperator`) so RLS guarantees no cross-tenant
 * data leaks. White-label is enforced by pulling all branding (name, color, logo,
 * contact) from the operator record — never platform branding.
 *
 * Resilience contract: the Resend client is constructed lazily from the
 * RESEND_API_KEY env var. If the key is missing, we log once and no-op. These
 * functions NEVER throw — a failed/disabled email must never break a booking,
 * payment, or refund flow. Callers may `void` them or await for a result flag.
 *
 * Wiring (see followups): the orders slice should call sendBookingConfirmation +
 * sendStaffNewBooking after an order is created; the payments/refund slice should
 * call sendRefundReceipt after a refund is recorded; a scheduled job should call
 * sendReminder ahead of each booking's start time.
 */

import { Resend } from 'resend';
import { adminPrisma, forOperator, Prisma, type TenantClient } from '@marina/database';
import { formatUSD } from '@marina/core';
import {
  renderEmail,
  renderEmailText,
  BookingConfirmation,
  BookingReminder,
  RefundReceipt,
  StaffNewBooking,
  type BrandProps,
} from '@marina/emails';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Outcome of a notification attempt. Functions never throw — they report here. */
export interface NotificationResult {
  sent: boolean;
  /** Provider message id when sent. */
  id?: string;
  /** Why it did not send (skipped / no recipient / provider error). */
  skippedReason?: string;
}

const skipped = (reason: string): NotificationResult => ({ sent: false, skippedReason: reason });

// ---------------------------------------------------------------------------
// Lazy Resend client
// ---------------------------------------------------------------------------

let cachedResend: Resend | null = null;
let warnedMissingKey = false;

/** Lazily construct the Resend client. Returns null (and warns once) if unconfigured. */
function getResend(): Resend | null {
  if (cachedResend) return cachedResend;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn(
        '[notifications] RESEND_API_KEY is not set — email sending is disabled (no-op).',
      );
    }
    return null;
  }
  cachedResend = new Resend(apiKey);
  return cachedResend;
}

/**
 * The "from" address. Configurable per deployment via RESEND_FROM_EMAIL; we prefix
 * the operator's name for a white-label sender identity, e.g.
 * `Lake Sonoma Marina <bookings@send.example.com>`.
 */
function fromAddress(brandName: string): string {
  const email = process.env.RESEND_FROM_EMAIL ?? 'bookings@notifications.marina.app';
  // Strip characters that would break the RFC-5322 display name.
  const safeName = brandName.replace(/["\\\r\n]/g, '').trim();
  return safeName ? `${safeName} <${email}>` : email;
}

// ---------------------------------------------------------------------------
// Shared send helper
// ---------------------------------------------------------------------------

interface SendArgs {
  brandName: string;
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

/** Single choke point for actually dispatching an email. Never throws. */
async function dispatch(args: SendArgs): Promise<NotificationResult> {
  const recipients = (Array.isArray(args.to) ? args.to : [args.to]).filter(
    (addr): addr is string => Boolean(addr && addr.includes('@')),
  );
  if (recipients.length === 0) return skipped('no valid recipient');

  const resend = getResend();
  if (!resend) return skipped('RESEND_API_KEY not configured');

  try {
    const { data, error } = await resend.emails.send({
      from: fromAddress(args.brandName),
      to: recipients,
      subject: args.subject,
      html: args.html,
      text: args.text,
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
    });
    if (error) {
      console.error('[notifications] Resend error:', error);
      return skipped(`provider error: ${error.message ?? 'unknown'}`);
    }
    return { sent: true, id: data?.id };
  } catch (err) {
    // Network / unexpected failures must never bubble into the caller's flow.
    console.error('[notifications] Unexpected send failure:', err);
    return skipped('unexpected send failure');
  }
}

// ---------------------------------------------------------------------------
// Branding & formatting helpers
// ---------------------------------------------------------------------------

/** Build white-label email branding props from an operator row. */
function brandFromOperator(operator: {
  name_external: string;
  brand_color: string;
  logo_light_url: string | null;
  logo_dark_url: string | null;
}): BrandProps {
  return {
    brandName: operator.name_external,
    brandColor: operator.brand_color,
    // Email headers use a colored brand bar, so prefer the light (on-dark) logo.
    logoUrl: operator.logo_light_url ?? operator.logo_dark_url ?? undefined,
  };
}

/** A reply-to / footer contact line assembled from operator data. */
function contactLine(operator: { name_external: string; phone: string | null; website: string | null }): string {
  return [operator.name_external, operator.phone, operator.website].filter(Boolean).join(' · ');
}

function dateLabelFor(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  }).format(date);
}

function timeLabelFor(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(date);
}

function fullName(first: string, last: string): string {
  return [first, last].filter(Boolean).join(' ').trim();
}

const ENV_URL = (process.env.APP_BASE_URL ?? '').replace(/\/+$/, '');

/** Absolute admin URL for staff to manage a booking, scoped to the operator slug. */
function manageUrlFor(slug: string, orderId: string): string {
  const base = ENV_URL || 'https://app.marina.app';
  return `${base}/${slug}/admin/orders/${orderId}`;
}

// ---------------------------------------------------------------------------
// Data loading (tenant-scoped)
// ---------------------------------------------------------------------------

/**
 * Loads an order with everything needed to render booking emails, scoped to the
 * operator via RLS. Returns null if not found (e.g. wrong tenant / deleted).
 */
async function loadOrderBundle(db: TenantClient, orderId: string) {
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

type OrderBundle = NonNullable<Awaited<ReturnType<typeof loadOrderBundle>>>;

/** Build the price-breakdown lines for a confirmation email from order totals. */
function priceLines(order: OrderBundle): Array<{ label: string; amountCents: number }> {
  const lines: Array<{ label: string; amountCents: number }> = [
    { label: 'Subtotal', amountCents: order.subtotal_cents },
  ];
  if (order.discount_cents > 0) lines.push({ label: 'Discount', amountCents: -order.discount_cents });
  if (order.tax_cents > 0) lines.push({ label: 'Tax', amountCents: order.tax_cents });
  if (order.processing_fee_cents > 0)
    lines.push({ label: 'Processing fee', amountCents: order.processing_fee_cents });
  if (order.tip_cents > 0) lines.push({ label: 'Tip', amountCents: order.tip_cents });
  return lines;
}

/** Derive activity/date/time/party labels from the order's first/primary item. */
function bookingFacts(order: OrderBundle) {
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

const channelLabelMap: Record<string, string> = {
  CUSTOMER: 'Online',
  STAFF: 'POS',
  KIOSK: 'Kiosk',
};

const cancellationPolicy =
  'Free reschedule or cancellation is available up to the window shown in your ' +
  'booking details. Within that window, fees may apply. Reply to this email or ' +
  'contact us with any questions about your reservation.';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send the booking confirmation to the customer after an order is created.
 * Call from the orders slice once the order + items are persisted.
 */
export async function sendBookingConfirmation(input: {
  operatorId: string;
  orderId: string;
}): Promise<NotificationResult> {
  try {
    const db = forOperator(input.operatorId);
    const order = await loadOrderBundle(db, input.orderId);
    if (!order) return skipped('order not found');
    if (!order.customer.email) return skipped('customer has no email');

    const brand = brandFromOperator(order.operator);
    const facts = bookingFacts(order);

    const element = BookingConfirmation({
      ...brand,
      orderNumber: order.order_number,
      customerName: order.customer.first_name || fullName(order.customer.first_name, order.customer.last_name),
      activityName: facts.activityName,
      dateLabel: facts.dateLabel,
      timeLabel: facts.timeLabel,
      partySize: facts.partySize,
      locationLabel: facts.locationLabel,
      lineItems: priceLines(order),
      totalCents: order.total_cents,
      cancellationPolicy,
    });

    const [html, text] = await Promise.all([renderEmail(element), renderEmailText(element)]);

    return dispatch({
      brandName: brand.brandName,
      to: order.customer.email,
      subject: `Your booking is confirmed — ${order.order_number} · ${formatUSD(order.total_cents)}`,
      html,
      text,
    });
  } catch (err) {
    console.error('[notifications] sendBookingConfirmation failed:', err);
    return skipped('unexpected failure');
  }
}

/**
 * Notify staff that a new booking came in. Emails active staff members of the
 * operator (Owner/Admin/Manager/Staff) so the front desk sees it immediately.
 * Call from the orders slice alongside sendBookingConfirmation.
 */
export async function sendStaffNewBooking(input: {
  operatorId: string;
  orderId: string;
}): Promise<NotificationResult> {
  try {
    const db = forOperator(input.operatorId);
    const order = await loadOrderBundle(db, input.orderId);
    if (!order) return skipped('order not found');

    const staff = await db.staffMember.findMany({
      where: { is_active: true },
      select: { email: true, role: true },
    });
    const recipients = staff
      .filter((s) => s.role !== 'GUIDE') // guides don't manage bookings
      .map((s) => s.email)
      .filter((email): email is string => Boolean(email));

    if (recipients.length === 0) return skipped('no staff recipients');

    const brand = brandFromOperator(order.operator);
    const facts = bookingFacts(order);

    const element = StaffNewBooking({
      ...brand,
      orderNumber: order.order_number,
      activityName: facts.activityName,
      dateLabel: facts.dateLabel,
      timeLabel: facts.timeLabel,
      partySize: facts.partySize,
      locationLabel: facts.locationLabel,
      customerName: fullName(order.customer.first_name, order.customer.last_name),
      customerEmail: order.customer.email,
      customerPhone: order.customer.phone ?? undefined,
      totalCents: order.total_cents,
      channelLabel: channelLabelMap[order.created_by] ?? undefined,
      manageUrl: manageUrlFor(order.operator.slug, order.id),
    });

    const [html, text] = await Promise.all([renderEmail(element), renderEmailText(element)]);

    return dispatch({
      brandName: brand.brandName,
      to: recipients,
      subject: `New booking: ${facts.activityName} — ${order.order_number}`,
      html,
      text,
    });
  } catch (err) {
    console.error('[notifications] sendStaffNewBooking failed:', err);
    return skipped('unexpected failure');
  }
}

/**
 * Send a pre-arrival reminder to the customer. Intended to run from a scheduled
 * job some hours before the booking start time.
 */
export async function sendReminder(input: {
  operatorId: string;
  orderId: string;
  /** Items to bring; falls back to a sensible default list when omitted. */
  whatToBring?: string[];
  /** Minutes before start to recommend check-in (default 30). */
  checkInLeadMinutes?: number;
}): Promise<NotificationResult> {
  try {
    const db = forOperator(input.operatorId);
    const order = await loadOrderBundle(db, input.orderId);
    if (!order) return skipped('order not found');
    if (!order.customer.email) return skipped('customer has no email');
    if (order.status !== 'UPCOMING') return skipped(`order status is ${order.status}`);

    const brand = brandFromOperator(order.operator);
    const facts = bookingFacts(order);

    const leadMinutes = input.checkInLeadMinutes ?? 30;
    const checkInTimeLabel = facts.slotDate
      ? timeLabelFor(new Date(facts.slotDate.getTime() - leadMinutes * 60_000), facts.timezone)
      : facts.timeLabel;

    const whatToBring =
      input.whatToBring && input.whatToBring.length > 0
        ? input.whatToBring
        : [
            'A valid photo ID for the reservation holder',
            'Your confirmation number or this email',
            'Sun protection (hat, sunscreen, sunglasses)',
            'Closed-toe shoes and a change of clothes',
          ];

    const element = BookingReminder({
      ...brand,
      orderNumber: order.order_number,
      customerName: order.customer.first_name || fullName(order.customer.first_name, order.customer.last_name),
      activityName: facts.activityName,
      dateLabel: facts.dateLabel,
      timeLabel: facts.timeLabel,
      checkInTimeLabel,
      locationLabel: facts.locationLabel,
      whatToBring,
    });

    const [html, text] = await Promise.all([renderEmail(element), renderEmailText(element)]);

    return dispatch({
      brandName: brand.brandName,
      to: order.customer.email,
      subject: `Reminder: your ${facts.activityName} is coming up`,
      html,
      text,
    });
  } catch (err) {
    console.error('[notifications] sendReminder failed:', err);
    return skipped('unexpected failure');
  }
}

/**
 * Send a refund receipt to the customer. Call from the payments/refund slice
 * after a refund is recorded on a Payment row.
 */
export async function sendRefundReceipt(input: {
  operatorId: string;
  paymentId: string;
  /** Amount refunded in this action, integer cents. Defaults to the payment's refunded_cents. */
  refundedCents?: number;
  /** Reason shown to the customer. */
  reason?: string;
}): Promise<NotificationResult> {
  try {
    const db = forOperator(input.operatorId);
    const payment = await db.payment.findUnique({
      where: { id: input.paymentId },
      include: {
        order: {
          include: { operator: true, customer: true },
        },
      },
    });
    if (!payment) return skipped('payment not found');

    const order = payment.order;
    if (!order.customer.email) return skipped('customer has no email');

    const refundedCents = input.refundedCents ?? payment.refunded_cents;
    if (refundedCents <= 0) return skipped('no refunded amount');

    const brand = brandFromOperator(order.operator);
    const timezone = order.operator.timezone ?? 'America/Los_Angeles';

    const paymentMethodLabel =
      payment.card_brand && payment.card_last_four
        ? `${payment.card_brand} ending ${payment.card_last_four}`
        : payment.method === 'CASH'
          ? 'Cash'
          : payment.method === 'GIFT_CARD'
            ? 'Gift card'
            : undefined;

    const element = RefundReceipt({
      ...brand,
      orderNumber: order.order_number,
      customerName: order.customer.first_name || fullName(order.customer.first_name, order.customer.last_name),
      refundedCents,
      reason: input.reason ?? 'Refund processed',
      originalTotalCents: order.total_cents,
      remainingBalanceCents: Math.max(0, order.amount_paid_cents - refundedCents),
      processedDateLabel: dateLabelFor(payment.processed_at, timezone),
      paymentMethodLabel,
    });

    const [html, text] = await Promise.all([renderEmail(element), renderEmailText(element)]);

    return dispatch({
      brandName: brand.brandName,
      to: order.customer.email,
      subject: `Refund issued for ${order.order_number} — ${formatUSD(refundedCents)}`,
      html,
      text,
    });
  } catch (err) {
    console.error('[notifications] sendRefundReceipt failed:', err);
    return skipped('unexpected failure');
  }
}

// ===========================================================================
// Automated pre-arrival reminders (the scheduler-facing engine)
// ===========================================================================

/**
 * OrderEvent type stamped once a reminder has been processed for an order, so
 * re-running the sweep never double-reminds. Using an OrderEvent (rather than a
 * new column) keeps this migration-free and gives a visible audit trail.
 */
export const REMINDER_EVENT_TYPE = 'REMINDER_SENT';

export interface ReminderRunResult {
  operatorId: string;
  /** Orders whose trip falls in the window and hadn't been reminded. */
  due: number;
  /** Of those, how many actually dispatched (a real email went out). */
  delivered: number;
  /** Processed but not delivered (e.g. no Resend key, or no email on file). */
  noop: number;
}

/**
 * Order ids that should receive a pre-arrival reminder now: status UPCOMING, with a
 * non-cancelled item whose timeslot starts in [now, until), and no prior
 * REMINDER_SENT event. Exported so the selection logic is unit-testable without any
 * email provider configured.
 */
export async function selectDueReminderOrderIds(
  db: TenantClient,
  now: Date,
  until: Date,
): Promise<string[]> {
  const orders = await db.order.findMany({
    where: {
      status: 'UPCOMING',
      items: {
        some: { status: { not: 'CANCELLED' }, timeslot: { datetime: { gte: now, lt: until } } },
      },
      history: { none: { type: REMINDER_EVENT_TYPE } },
    },
    select: { id: true },
  });
  return orders.map((o) => o.id);
}

/**
 * Send pre-arrival reminders for one operator's bookings starting within
 * `withinHours`. Idempotent: each order gets a REMINDER_SENT audit event once
 * processed, so subsequent runs skip it. Without a Resend key the send is a no-op
 * but the order is still marked processed (metadata records `delivered:false`), so
 * the sweep stays idempotent in dev; wire the key before relying on delivery.
 */
export async function runDueReminders(
  operatorId: string,
  opts: { withinHours: number; now?: Date; actor?: string },
): Promise<ReminderRunResult> {
  const now = opts.now ?? new Date();
  const until = new Date(now.getTime() + Math.max(0, opts.withinHours) * 3_600_000);
  const db = forOperator(operatorId);

  const dueIds = await selectDueReminderOrderIds(db, now, until);

  let delivered = 0;
  let noop = 0;
  for (const orderId of dueIds) {
    let result: NotificationResult;
    try {
      result = await sendReminder({ operatorId, orderId });
    } catch (err) {
      console.error('[notifications] runDueReminders send failed:', err);
      result = skipped('unexpected failure');
    }
    if (result.sent) delivered += 1;
    else noop += 1;

    // Stamp the audit event so this order isn't reconsidered next run.
    await db.orderEvent.create({
      data: {
        operator_id: operatorId,
        order_id: orderId,
        type: REMINDER_EVENT_TYPE,
        description: result.sent
          ? 'Pre-arrival reminder sent'
          : `Pre-arrival reminder processed (not delivered: ${result.skippedReason ?? 'no provider'})`,
        actor: opts.actor ?? 'system',
        metadata: {
          delivered: result.sent,
          providerId: result.id ?? null,
          reason: result.skippedReason ?? null,
        } as Prisma.InputJsonValue,
      },
    });
  }

  return { operatorId, due: dueIds.length, delivered, noop };
}

/**
 * Run the reminder sweep across every active operator — the entry point a cron/
 * scheduled task calls (via the internal HTTP endpoint). Iterates operators with the
 * admin client, then does each operator's work through its RLS-scoped tenant client.
 */
export async function runAllDueReminders(opts: {
  withinHours: number;
  now?: Date;
}): Promise<{ operators: number; due: number; delivered: number; noop: number; perOperator: ReminderRunResult[] }> {
  const operators = await adminPrisma.operator.findMany({
    where: { is_active: true },
    select: { id: true },
  });

  const perOperator: ReminderRunResult[] = [];
  for (const op of operators) {
    perOperator.push(await runDueReminders(op.id, opts));
  }

  return {
    operators: operators.length,
    due: perOperator.reduce((n, r) => n + r.due, 0),
    delivered: perOperator.reduce((n, r) => n + r.delivered, 0),
    noop: perOperator.reduce((n, r) => n + r.noop, 0),
    perOperator,
  };
}
