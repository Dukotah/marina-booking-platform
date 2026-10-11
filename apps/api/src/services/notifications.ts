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
 * Because most callers `void` them, every swallowed failure is also handed to the
 * error sink (services/errors.ts): nobody is checking the return value, so an
 * email path that has been dead for a week would otherwise look identical to one
 * that works.
 *
 * Wiring (see followups): the orders slice should call sendBookingConfirmation +
 * sendStaffNewBooking after an order is created; the payments/refund slice should
 * call sendRefundReceipt after a refund is recorded; a scheduled job should call
 * sendReminder ahead of each booking's start time.
 */

import { Resend } from 'resend';
import { adminPrisma, forOperator, Prisma, type TenantClient } from '@marina/database';
import { formatUSD, qrSvg } from '@marina/core';
import { signCheckinToken } from '@marina/core/checkin-token';
import {
  renderEmail,
  renderEmailText,
  BookingConfirmation,
  BookingCancelled,
  BookingReminder,
  RefundReceipt,
  ReviewRequest,
  StaffNewBooking,
  GiftCardIssued,
} from '@marina/emails';
import {
  type NotificationResult,
  skipped,
  brandFromOperator,
  dateLabelFor,
  timeLabelFor,
  fullName,
  loadOrderBundle,
  type OrderBundle,
  bookingFacts,
  tripEnd,
  unsignedWaiverLinks,
  loadConfirmationDetails,
  loadCancellationFacts,
  refundedCardLabel,
} from './notification-data.js';
import { sendReminderSms, sendReviewRequestSms, sendSms } from './sms.js';
import { selectStaffNotifyRecipients } from './staff-notify-prefs.js';
import { loadTemplateOverride, resolveTemplate } from './message-templates.js';
import { sandboxEnabled, captureMessage } from './sandbox.js';
import { captureError } from './errors.js';

export type { NotificationResult };

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
  /** Tenant the message belongs to — required so a sandbox capture is scoped. */
  operatorId: string;
  /** What this message is (booking_confirmation, reminder, ...) for the console. */
  kind: string;
  brandName: string;
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  orderId?: string | null;
  orderNumber?: string | null;
}

/**
 * What an error record is allowed to know about a failed send: which message it
 * was and which order it belonged to. Not the addresses, not the subject, and
 * never the rendered body — those are the guest's name, itinerary and contact
 * details, and an error record is not a second copy of the mail.
 */
function dispatchContext(args: SendArgs): Record<string, unknown> {
  return {
    provider: 'resend',
    kind: args.kind,
    order_id: args.orderId ?? null,
    order_number: args.orderNumber ?? null,
  };
}

/** Single choke point for actually dispatching an email. Never throws. */
async function dispatch(args: SendArgs): Promise<NotificationResult> {
  const recipients = (Array.isArray(args.to) ? args.to : [args.to]).filter(
    (addr): addr is string => Boolean(addr && addr.includes('@')),
  );
  if (recipients.length === 0) return skipped('no valid recipient');

  // Local sandbox: store the fully rendered message instead of sending it, so
  // the whole flow is testable with no Resend account. See services/sandbox.ts.
  if (sandboxEnabled()) {
    return captureMessage({
      operatorId: args.operatorId,
      channel: 'EMAIL',
      kind: args.kind,
      to: recipients.join(', '),
      from: fromAddress(args.brandName),
      subject: args.subject,
      html: args.html,
      text: args.text,
      orderId: args.orderId ?? null,
      orderNumber: args.orderNumber ?? null,
    });
  }

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
      // Resend reports a rejection in the result rather than by throwing, so
      // there is no stack to group on. A named Error built here gives the sink a
      // real top frame; passing the bare object would file every provider
      // rejection as one anonymous entry with no route back to this call site.
      const providerError = new Error(`Resend rejected the send: ${error.message ?? 'unknown'}`);
      providerError.name = error.name ?? 'ResendError';
      await captureError(providerError, {
        operatorId: args.operatorId,
        route: 'notifications.dispatch',
        extra: { ...dispatchContext(args), recipients: recipients.length },
      });
      return skipped(`provider error: ${error.message ?? 'unknown'}`);
    }
    return { sent: true, id: data?.id };
  } catch (err) {
    // Network / unexpected failures must never bubble into the caller's flow.
    await captureError(err, {
      operatorId: args.operatorId,
      route: 'notifications.dispatch',
      extra: { ...dispatchContext(args), recipients: recipients.length },
    });
    return skipped('unexpected send failure');
  }
}

// ---------------------------------------------------------------------------
// Email-specific helpers (shared data/formatting live in notification-data.ts)
// ---------------------------------------------------------------------------

/** A reply-to / footer contact line assembled from operator data. */
function contactLine(operator: { name_external: string; phone: string | null; website: string | null }): string {
  return [operator.name_external, operator.phone, operator.website].filter(Boolean).join(' · ');
}

const ENV_URL = (process.env.APP_BASE_URL ?? '').replace(/\/+$/, '');

/** Absolute admin URL for staff to manage a booking, scoped to the operator slug. */
function manageUrlFor(slug: string, orderId: string): string {
  const base = ENV_URL || 'https://app.marina.app';
  return `${base}/${slug}/admin/orders/${orderId}`;
}

// ---------------------------------------------------------------------------
// Email content builders
// ---------------------------------------------------------------------------

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

    // Items still needing a signed liability waiver get a prominent
    // "sign before you arrive" link to the standalone clause-level signer.
    const waiverLinks = unsignedWaiverLinks(order);

    // Operator custom-question answers flagged to echo back to the guest.
    const customerDetails = await loadConfirmationDetails(db, order);

    // Real, HMAC-signed check-in QR for the primary booked item — the same token
    // POST /api/checkin/scan verifies. Rendered inline so staff can scan it off
    // the guest's email; clients that strip SVG fall back to the order number.
    const primaryItem = order.items[0];
    const checkinQrSvg = primaryItem
      ? qrSvg(signCheckinToken({ orderNumber: order.order_number, orderItemId: primaryItem.id }), {
          dark: '#2B241C',
          light: '#FFFEFB',
          margin: 2,
        })
      : undefined;

    const element = BookingConfirmation({
      ...brand,
      orderNumber: order.order_number,
      customerName: fullName(order.customer.first_name, order.customer.last_name) || order.customer.first_name || 'Guest',
      activityName: facts.activityName,
      dateLabel: facts.dateLabel,
      timeLabel: facts.timeLabel,
      partySize: facts.partySize,
      locationLabel: facts.locationLabel,
      lineItems: priceLines(order),
      totalCents: order.total_cents,
      // Reserve-now / pay-at-the-marina orders carry a full balance due; the email
      // then states the amount owed on arrival and what to bring.
      balanceDueCents: order.balance_due_cents,
      cancellationPolicy,
      ...(checkinQrSvg ? { checkinQrSvg } : {}),
      ...(waiverLinks.length > 0 ? { waiverLinks } : {}),
      ...(customerDetails.length > 0 ? { customerDetails } : {}),
    });

    const [html, text] = await Promise.all([renderEmail(element), renderEmailText(element)]);

    // Editable message templates (Singenuity §4): let the operator override the
    // subject line. The body still renders from the branded React template; a blank
    // or missing override cleanly falls back to the default subject.
    const override = await loadTemplateOverride(db, 'BOOKING_CONFIRMATION');
    const { subject } = resolveTemplate({
      defaultSubject: `Your booking is confirmed — ${order.order_number} · ${formatUSD(order.total_cents)}`,
      override,
      facts: {
        order_number: order.order_number,
        total: formatUSD(order.total_cents),
        activity: facts.activityName,
        date: facts.dateLabel,
        time: facts.timeLabel,
        brand_name: brand.brandName,
        customer_name: fullName(order.customer.first_name, order.customer.last_name) || order.customer.first_name || 'Guest',
      },
    });

    return dispatch({
      operatorId: input.operatorId,
      kind: 'booking_confirmation',
      brandName: brand.brandName,
      to: order.customer.email,
      subject,
      html,
      text,
      orderId: order.id,
      orderNumber: order.order_number,
    });
  } catch (err) {
    await captureError(err, {
      operatorId: input.operatorId,
      route: 'notifications.sendBookingConfirmation',
      extra: { order_id: input.orderId },
    });
    return skipped('unexpected failure');
  }
}

/**
 * Notify staff that a new booking came in. Emails active staff members of the
 * operator (Owner/Admin/Manager/Staff) so the front desk sees it immediately.
 * Call from the orders slice alongside sendBookingConfirmation.
 *
 * Per-staff preferences (StaffNotificationPref) make this NOT all-or-nothing:
 *  - a member with no pref row keeps the legacy default (email on, SMS off, every
 *    activity), so existing behaviour is unchanged until someone opts a member down;
 *  - email_enabled / sms_enabled gate each channel independently;
 *  - a non-empty activity_ids narrows alerts to bookings whose activities overlap.
 * SMS alerts go to the member's sms_phone (StaffMember has no phone column).
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
      where: { is_active: true, role: { not: 'GUIDE' } }, // guides don't manage bookings
      select: {
        email: true,
        notification_pref: {
          select: {
            email_enabled: true,
            sms_enabled: true,
            sms_phone: true,
            activity_ids: true,
          },
        },
      },
    });

    // The activities this booking touches — used to honour each member's filter.
    const orderActivityIds = order.items.map((item) => item.activity.id);
    const { emails: emailRecipients, phones: smsRecipients } = selectStaffNotifyRecipients(
      staff,
      orderActivityIds,
    );

    if (emailRecipients.length === 0 && smsRecipients.length === 0) {
      return skipped('no staff recipients');
    }

    const brand = brandFromOperator(order.operator);
    const facts = bookingFacts(order);

    // Fire SMS alerts (fire-and-forget; sendSms never throws). Independent of email.
    if (smsRecipients.length > 0) {
      const smsBody =
        `${brand.brandName}: new booking ${order.order_number} — ` +
        `${facts.activityName}${facts.dateLabel ? ` on ${facts.dateLabel}` : ''}` +
        ` (party ${facts.partySize}).`;
      await Promise.all(
        smsRecipients.map((phone) =>
          sendSms(input.operatorId, phone, smsBody, 'staff_new_booking'),
        ),
      );
    }

    if (emailRecipients.length === 0) {
      return { sent: true };
    }

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
      operatorId: input.operatorId,
      kind: 'staff_new_booking',
      brandName: brand.brandName,
      to: emailRecipients,
      subject: `New booking: ${facts.activityName} — ${order.order_number}`,
      html,
      text,
      orderId: order.id,
      orderNumber: order.order_number,
    });
  } catch (err) {
    await captureError(err, {
      operatorId: input.operatorId,
      route: 'notifications.sendStaffNewBooking',
      extra: { order_id: input.orderId },
    });
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

    // The reminder is the last chance to sign at home instead of at the dock.
    const waiverLinks = unsignedWaiverLinks(order);

    const element = BookingReminder({
      ...brand,
      orderNumber: order.order_number,
      customerName: fullName(order.customer.first_name, order.customer.last_name) || order.customer.first_name || 'Guest',
      activityName: facts.activityName,
      dateLabel: facts.dateLabel,
      timeLabel: facts.timeLabel,
      checkInTimeLabel,
      locationLabel: facts.locationLabel,
      whatToBring,
      ...(waiverLinks.length > 0 ? { waiverLinks } : {}),
    });

    const [html, text] = await Promise.all([renderEmail(element), renderEmailText(element)]);

    return dispatch({
      operatorId: input.operatorId,
      kind: 'reminder',
      brandName: brand.brandName,
      to: order.customer.email,
      subject: `Reminder: your ${facts.activityName} is coming up`,
      html,
      text,
      orderId: order.id,
      orderNumber: order.order_number,
    });
  } catch (err) {
    await captureError(err, {
      operatorId: input.operatorId,
      route: 'notifications.sendReminder',
      extra: { order_id: input.orderId },
    });
    return skipped('unexpected failure');
  }
}

/**
 * Send a post-trip review-request email to the customer. Intended to run from the
 * review sweep some hours after the booking's trip has ended. No-ops cleanly when
 * the operator has no review_url configured, the order is cancelled/no-show, or the
 * customer has no email.
 */
export async function sendReviewRequest(input: {
  operatorId: string;
  orderId: string;
}): Promise<NotificationResult> {
  try {
    const db = forOperator(input.operatorId);
    const order = await loadOrderBundle(db, input.orderId);
    if (!order) return skipped('order not found');
    if (order.status === 'CANCELLED' || order.status === 'NO_SHOW') {
      return skipped(`order status is ${order.status}`);
    }
    if (!order.customer.email) return skipped('customer has no email');

    const reviewUrl = order.operator.review_url?.trim();
    if (!reviewUrl) return skipped('operator has no review_url');

    const brand = brandFromOperator(order.operator);
    const facts = bookingFacts(order);
    const customerName =
      fullName(order.customer.first_name, order.customer.last_name) ||
      order.customer.first_name ||
      'Guest';

    const element = ReviewRequest({
      ...brand,
      orderNumber: order.order_number,
      customerName,
      activityName: facts.activityName,
      dateLabel: facts.dateLabel,
      reviewUrl,
    });

    const [html, text] = await Promise.all([renderEmail(element), renderEmailText(element)]);

    // Editable message templates: operators may override the subject. The body
    // still renders from the branded React template; a blank/missing override
    // falls back to the default subject.
    const override = await loadTemplateOverride(db, 'REVIEW_REQUEST');
    const { subject } = resolveTemplate({
      defaultSubject: `How was your ${facts.activityName}? Leave ${brand.brandName} a review`,
      override,
      facts: {
        order_number: order.order_number,
        activity: facts.activityName,
        date: facts.dateLabel,
        time: facts.timeLabel,
        brand_name: brand.brandName,
        customer_name: customerName,
      },
    });

    return dispatch({
      operatorId: input.operatorId,
      kind: 'review_request',
      brandName: brand.brandName,
      to: order.customer.email,
      subject,
      html,
      text,
      orderId: order.id,
      orderNumber: order.order_number,
    });
  } catch (err) {
    await captureError(err, {
      operatorId: input.operatorId,
      route: 'notifications.sendReviewRequest',
      extra: { order_id: input.orderId },
    });
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
      customerName: fullName(order.customer.first_name, order.customer.last_name) || order.customer.first_name || 'Guest',
      refundedCents,
      reason: input.reason ?? 'Refund processed',
      originalTotalCents: order.total_cents,
      remainingBalanceCents: Math.max(0, order.amount_paid_cents - refundedCents),
      processedDateLabel: dateLabelFor(payment.processed_at, timezone),
      paymentMethodLabel,
    });

    const [html, text] = await Promise.all([renderEmail(element), renderEmailText(element)]);

    return dispatch({
      operatorId: input.operatorId,
      kind: 'refund_receipt',
      brandName: brand.brandName,
      to: order.customer.email,
      subject: `Refund issued for ${order.order_number} — ${formatUSD(refundedCents)}`,
      html,
      text,
      orderId: order.id,
      orderNumber: order.order_number,
    });
  } catch (err) {
    await captureError(err, {
      operatorId: input.operatorId,
      route: 'notifications.sendRefundReceipt',
      extra: { payment_id: input.paymentId },
    });
    return skipped('unexpected failure');
  }
}

/**
 * Send a booking-cancelled notice to the customer after an order is cancelled.
 * Fire this FIRE-AND-FORGET from the cancel path AFTER the transaction commits —
 * the refund facts are read back off the ORDER_CANCELLED OrderEvent the cancel
 * stamped, so this is self-contained and re-renderable (never recomputes money).
 * Never throws; no-ops cleanly when the order/email/cancel-event is missing.
 */
export async function sendBookingCancellation(input: {
  operatorId: string;
  orderId: string;
}): Promise<NotificationResult> {
  try {
    const db = forOperator(input.operatorId);
    const order = await loadOrderBundle(db, input.orderId);
    if (!order) return skipped('order not found');
    if (order.status !== 'CANCELLED') return skipped(`order status is ${order.status}`);
    if (!order.customer.email) return skipped('customer has no email');

    const refund = await loadCancellationFacts(db, order.id);
    if (!refund) return skipped('no cancellation event');

    const brand = brandFromOperator(order.operator);
    const facts = bookingFacts(order);
    const cardLabel = refund.cardRefundCents > 0 ? await refundedCardLabel(db, order.id) : undefined;

    const element = BookingCancelled({
      ...brand,
      orderNumber: order.order_number,
      customerName:
        fullName(order.customer.first_name, order.customer.last_name) ||
        order.customer.first_name ||
        'Guest',
      activityName: facts.activityName,
      dateLabel: facts.dateLabel,
      timeLabel: facts.timeLabel,
      locationLabel: facts.locationLabel,
      ...(refund.reason ? { reason: refund.reason } : {}),
      refundedCents: refund.refundCents,
      cardRefundCents: refund.cardRefundCents,
      giftRefundCents: refund.giftRefundCents,
      feeCents: refund.feeCents,
      ...(cardLabel ? { cardLabel } : {}),
    });

    const [html, text] = await Promise.all([renderEmail(element), renderEmailText(element)]);

    // Editable message templates (Singenuity §4): operators may override the
    // subject. The body still renders from the branded React template; a blank or
    // missing override falls back to the default subject.
    const override = await loadTemplateOverride(db, 'BOOKING_CANCELLED');
    const refundSuffix =
      refund.refundCents > 0 ? ` — ${formatUSD(refund.refundCents)} refunded` : '';
    const { subject } = resolveTemplate({
      defaultSubject: `Your booking was cancelled — ${order.order_number}${refundSuffix}`,
      override,
      facts: {
        order_number: order.order_number,
        refund: formatUSD(refund.refundCents),
        activity: facts.activityName,
        date: facts.dateLabel,
        time: facts.timeLabel,
        brand_name: brand.brandName,
        customer_name:
          fullName(order.customer.first_name, order.customer.last_name) ||
          order.customer.first_name ||
          'Guest',
      },
    });

    return dispatch({
      operatorId: input.operatorId,
      kind: 'booking_cancelled',
      brandName: brand.brandName,
      to: order.customer.email,
      subject,
      html,
      text,
      orderId: order.id,
      orderNumber: order.order_number,
    });
  } catch (err) {
    await captureError(err, {
      operatorId: input.operatorId,
      route: 'notifications.sendBookingCancellation',
      extra: { order_id: input.orderId },
    });
    return skipped('unexpected failure');
  }
}

/**
 * Notify a guide (staff member) that they've been scheduled to run a trip. Uses a
 * plain HTML/text body through the same Resend choke point (no dedicated template,
 * keeping guide scheduling migration-light). Never throws; no-ops without a key.
 */
export async function sendGuideAssignmentEmail(input: {
  operatorId: string;
  brandName: string;
  guideEmail: string;
  guideName?: string | null;
  activityName: string;
  dateLabel: string;
  timeLabel: string;
  locationLabel?: string;
  roleLabel?: string | null;
}): Promise<NotificationResult> {
  try {
    if (!input.guideEmail || !input.guideEmail.includes('@')) {
      return skipped('guide has no email');
    }
    const greeting = input.guideName ? `Hi ${input.guideName},` : 'Hi,';
    const where = input.locationLabel ? ` at ${input.locationLabel}` : '';
    const roleLine = input.roleLabel ? ` Your role: ${input.roleLabel}.` : '';
    const line = `You're scheduled to guide "${input.activityName}"${where} on ${input.dateLabel} at ${input.timeLabel}.${roleLine}`;

    const text = `${greeting}\n\n${line}\n\n— ${input.brandName}`;
    const html =
      `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#0f172a">` +
      `<p>${greeting}</p><p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>` +
      `<p style="color:#64748b">— ${input.brandName}</p></div>`;

    return dispatch({
      operatorId: input.operatorId,
      kind: 'guide_assignment',
      brandName: input.brandName,
      to: input.guideEmail,
      subject: `You're guiding ${input.activityName} — ${input.dateLabel}`,
      html,
      text,
    });
  } catch (err) {
    await captureError(err, {
      operatorId: input.operatorId,
      route: 'notifications.sendGuideAssignmentEmail',
      // The guide's address is the payload here, so the activity is the only
      // identifying detail that goes in.
      extra: { activity: input.activityName },
    });
    return skipped('unexpected failure');
  }
}

/**
 * Tell a waitlisted guest a spot just opened on their sold-out time, with a deep
 * link straight to that activity/date/slot. Plain HTML through the same Resend
 * choke point (no dedicated React template — keeps the waitlist migration-light).
 * Never throws; no-ops without a key. The caller flips the entry to NOTIFIED
 * BEFORE calling this, so delivery state never gates the claim.
 */
export async function sendWaitlistSpotOpen(input: {
  operatorId: string;
  brand: {
    name_external: string;
    brand_color: string;
    logo_light_url: string | null;
    logo_dark_url: string | null;
  };
  guestName: string;
  guestEmail: string;
  activityName: string;
  slotDatetime: Date;
  timezone: string;
  bookingUrl: string;
}): Promise<NotificationResult> {
  try {
    if (!input.guestEmail || !input.guestEmail.includes('@')) {
      return skipped('guest has no email');
    }
    const brand = brandFromOperator(input.brand);
    const dateLabel = dateLabelFor(input.slotDatetime, input.timezone);
    const timeLabel = timeLabelFor(input.slotDatetime, input.timezone);
    const greeting = input.guestName ? `Hi ${input.guestName},` : 'Hi,';
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

    // Plain language on purpose: no hold is placed, so say exactly how it works.
    const line1 = `A spot just opened up for ${input.activityName} on ${dateLabel} at ${timeLabel}.`;
    const line2 = 'Spots go to whoever books first, so grab yours while it lasts:';
    const line3 = 'If the time no longer works for you, just ignore this email.';

    const text = `${greeting}\n\n${line1}\n\n${line2}\n${input.bookingUrl}\n\n${line3}\n\n— ${brand.brandName}`;
    const html =
      `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#0f172a">` +
      `<p>${esc(greeting)}</p>` +
      `<p>${esc(line1)}</p>` +
      `<p>${esc(line2)}</p>` +
      `<p><a href="${input.bookingUrl}" style="display:inline-block;background:${brand.brandColor};color:#ffffff;` +
      `padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Book this spot</a></p>` +
      `<p style="color:#64748b">${esc(line3)}</p>` +
      `<p style="color:#64748b">— ${esc(brand.brandName)}</p></div>`;

    return dispatch({
      operatorId: input.operatorId,
      kind: 'waitlist_spot_open',
      brandName: brand.brandName,
      to: input.guestEmail,
      subject: `A spot opened up — ${input.activityName}, ${dateLabel}`,
      html,
      text,
    });
  } catch (err) {
    await captureError(err, {
      operatorId: input.operatorId,
      route: 'notifications.sendWaitlistSpotOpen',
      extra: { activity: input.activityName },
    });
    return skipped('unexpected failure');
  }
}

/**
 * Send a staff-authored free-text message to a guest (the broadcast / "message
 * guest" surface). Plain HTML/text through the same Resend choke point — no React
 * template, since the body is whatever the staffer typed (weather hold, dock
 * moved, running late). Never throws; no-ops without a key or a valid address.
 */
export async function sendOperatorMessageEmail(input: {
  operatorId: string;
  brandName: string;
  to: string;
  guestName: string;
  subject: string;
  body: string;
  orderId?: string | null;
  orderNumber?: string | null;
}): Promise<NotificationResult> {
  try {
    const greeting = input.guestName ? `Hi ${input.guestName},` : 'Hi,';
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Preserve the staffer's line breaks in both channels.
    const paragraphs = input.body
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    const bodyHtml = paragraphs
      .map((p) => `<p>${esc(p).replace(/\n/g, '<br/>')}</p>`)
      .join('');

    const text = `${greeting}\n\n${input.body}\n\n— ${input.brandName}`;
    const html =
      `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#0f172a">` +
      `<p>${esc(greeting)}</p>${bodyHtml}` +
      `<p style="color:#64748b">— ${esc(input.brandName)}</p></div>`;

    return dispatch({
      operatorId: input.operatorId,
      kind: 'operator_message',
      brandName: input.brandName,
      to: input.to,
      subject: input.subject,
      html,
      text,
      orderId: input.orderId ?? null,
      orderNumber: input.orderNumber ?? null,
    });
  } catch (err) {
    await captureError(err, {
      operatorId: input.operatorId,
      route: 'notifications.sendOperatorMessageEmail',
      extra: { order_id: input.orderId ?? null },
    });
    return skipped('unexpected failure');
  }
}

/**
 * Email a newly-purchased gift card's code to its recipient. Called from the
 * public gift-card purchase flow AFTER the charge settles and the card is issued.
 * White-label branding is pulled from the operator record. Never throws.
 */
export async function sendGiftCardIssued(input: {
  operatorId: string;
  /** The issued card's redemption code. */
  code: string;
  /** Face value of the card, integer cents. */
  amountCents: number;
  /** Where the card goes. */
  recipientEmail: string;
  recipientName?: string | null;
  purchaserName?: string | null;
  giftMessage?: string | null;
}): Promise<NotificationResult> {
  try {
    if (!input.recipientEmail) return skipped('no recipient email');
    const db = forOperator(input.operatorId);
    const operator = await db.operator.findUnique({
      where: { id: input.operatorId },
      select: {
        name_external: true,
        brand_color: true,
        logo_light_url: true,
        logo_dark_url: true,
      },
    });
    if (!operator) return skipped('operator not found');

    const brand = brandFromOperator(operator);
    const element = GiftCardIssued({
      ...brand,
      code: input.code,
      amountCents: input.amountCents,
      recipientName: input.recipientName ?? undefined,
      purchaserName: input.purchaserName ?? undefined,
      giftMessage: input.giftMessage ?? undefined,
    });

    return dispatch({
      operatorId: input.operatorId,
      kind: 'gift_card_issued',
      brandName: brand.brandName,
      to: input.recipientEmail,
      subject: `You've received a ${formatUSD(input.amountCents)} gift card for ${brand.brandName}`,
      html: await renderEmail(element),
      text: await renderEmailText(element),
    });
  } catch (err) {
    await captureError(err, {
      operatorId: input.operatorId,
      route: 'notifications.sendGiftCardIssued',
    });
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
  /** Of those, how many dispatched at least one channel (email and/or SMS). */
  delivered: number;
  /** Processed but nothing delivered (e.g. no Resend/Twilio config, or no contact info). */
  noop: number;
  /** Of the delivered, how many sent a real SMS (Twilio configured + phone on file). */
  smsDelivered: number;
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
  let smsDelivered = 0;
  for (const orderId of dueIds) {
    // CLAIM this order's reminder BEFORE sending. A partial unique index on
    // OrderEvent(operator_id, order_id) WHERE type='REMINDER_SENT' lets only one
    // concurrent sweep insert this row; a second sweep loses with P2002 and skips,
    // so an order is never reminded twice even if two cron triggers overlap.
    let claimId: string;
    try {
      const claim = await db.orderEvent.create({
        data: {
          operator_id: operatorId,
          order_id: orderId,
          type: REMINDER_EVENT_TYPE,
          description: 'Pre-arrival reminder processing…',
          actor: opts.actor ?? 'system',
          metadata: { delivered: false } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      claimId = claim.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Another sweep already claimed this order's reminder — skip it.
        continue;
      }
      // A claim failure must not crash the whole sweep — log and move on.
      await captureError(err, {
        operatorId,
        route: 'notifications.runDueReminders',
        extra: { phase: 'claim', order_id: orderId },
      });
      continue;
    }

    // Send both channels on the same pass. Each is gated independently by its own
    // provider config (Resend for email, Twilio for SMS) and never throws.
    let email: NotificationResult;
    try {
      email = await sendReminder({ operatorId, orderId });
    } catch (err) {
      await captureError(err, {
        operatorId,
        route: 'notifications.runDueReminders',
        extra: { channel: 'email', order_id: orderId },
      });
      email = skipped('unexpected failure');
    }

    let sms: NotificationResult;
    try {
      sms = await sendReminderSms({ operatorId, orderId });
    } catch (err) {
      await captureError(err, {
        operatorId,
        route: 'notifications.runDueReminders',
        extra: { channel: 'sms', order_id: orderId },
      });
      sms = skipped('unexpected failure');
    }

    const anySent = email.sent || sms.sent;
    if (anySent) delivered += 1;
    else noop += 1;
    if (sms.sent) smsDelivered += 1;

    const channels = [email.sent ? 'email' : null, sms.sent ? 'SMS' : null].filter(Boolean);

    // Update the claim with the actual outcome (both channels covered by one event).
    // Guarded so a DB hiccup here can't abort the remaining orders — the claim above
    // already prevents a re-send.
    try {
      await db.orderEvent.update({
        where: { id: claimId },
        data: {
          description: anySent
            ? `Pre-arrival reminder sent (${channels.join(' + ')})`
            : `Pre-arrival reminder processed (not delivered: email ${email.skippedReason ?? 'n/a'}; sms ${sms.skippedReason ?? 'n/a'})`,
          metadata: {
            delivered: anySent,
            email: { delivered: email.sent, providerId: email.id ?? null, reason: email.skippedReason ?? null },
            sms: { delivered: sms.sent, providerId: sms.id ?? null, reason: sms.skippedReason ?? null },
          } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      await captureError(err, {
        operatorId,
        route: 'notifications.runDueReminders',
        extra: { phase: 'stamp', order_id: orderId },
      });
    }
  }

  return { operatorId, due: dueIds.length, delivered, noop, smsDelivered };
}

/**
 * Run the reminder sweep across every active operator — the entry point a cron/
 * scheduled task calls (via the internal HTTP endpoint). Iterates operators with the
 * admin client, then does each operator's work through its RLS-scoped tenant client.
 */
export async function runAllDueReminders(opts: {
  withinHours: number;
  now?: Date;
}): Promise<{ operators: number; due: number; delivered: number; noop: number; smsDelivered: number; perOperator: ReminderRunResult[] }> {
  const operators = await adminPrisma.operator.findMany({
    where: { is_active: true },
    select: { id: true },
  });

  const perOperator: ReminderRunResult[] = [];
  for (const op of operators) {
    // Isolate operators: one operator's failure must not stop reminders for the rest.
    try {
      perOperator.push(await runDueReminders(op.id, opts));
    } catch (err) {
      await captureError(err, { operatorId: op.id, route: 'notifications.runAllDueReminders' });
      perOperator.push({ operatorId: op.id, due: 0, delivered: 0, noop: 0, smsDelivered: 0 });
    }
  }

  return {
    operators: operators.length,
    due: perOperator.reduce((n, r) => n + r.due, 0),
    delivered: perOperator.reduce((n, r) => n + r.delivered, 0),
    noop: perOperator.reduce((n, r) => n + r.noop, 0),
    smsDelivered: perOperator.reduce((n, r) => n + r.smsDelivered, 0),
    perOperator,
  };
}

// ===========================================================================
// Automated post-trip review requests (the scheduler-facing engine)
// ===========================================================================

/**
 * OrderEvent type stamped once a review request has been processed for an order,
 * so re-running the sweep never double-asks. A partial unique index on
 * OrderEvent(operator_id, order_id) WHERE type='REVIEW_SENT' makes the claim
 * concurrency-safe (mirrors REMINDER_SENT).
 */
export const REVIEW_EVENT_TYPE = 'REVIEW_SENT';

export interface ReviewRunResult {
  operatorId: string;
  /** Orders whose trip ended in the window and hadn't been asked for a review. */
  due: number;
  /** Of those, how many dispatched at least one channel (email and/or SMS). */
  delivered: number;
  /** Processed but nothing delivered (no provider config, no review_url, no contact). */
  noop: number;
  /** Of the delivered, how many sent a real SMS (Twilio configured + phone on file). */
  smsDelivered: number;
}

/**
 * Order ids that should receive a post-trip review request now: status not
 * CANCELLED/NO_SHOW, with a non-cancelled item whose trip ENDED on or before
 * `endedBefore` (now - N hours), and no prior REVIEW_SENT event. The trip-end
 * cutoff needs each item's rate duration, which a Prisma `where` can't express
 * across the relation, so we pre-filter on slot start (start <= cutoff is a
 * necessary condition for end <= cutoff) then confirm the precise end in memory.
 * Exported so the selection is unit-testable without any provider configured.
 */
export async function selectDuePostTripOrderIds(
  db: TenantClient,
  endedBefore: Date,
): Promise<string[]> {
  const orders = await db.order.findMany({
    where: {
      status: { in: ['UPCOMING', 'COMPLETED'] },
      items: {
        some: { status: { not: 'CANCELLED' }, timeslot: { datetime: { lte: endedBefore } } },
      },
      history: { none: { type: REVIEW_EVENT_TYPE } },
    },
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

  return orders
    .filter((order) => {
      const end = tripEnd(order);
      return end !== null && end.getTime() <= endedBefore.getTime();
    })
    .map((o) => o.id);
}

/**
 * Send post-trip review requests for one operator's bookings whose trip ended at
 * least `afterHours` ago. Idempotent: each order gets a REVIEW_SENT audit event
 * once processed, so subsequent runs skip it. Without a Resend key (or a
 * review_url) the send is a no-op but the order is still marked processed, so the
 * sweep stays idempotent in dev.
 */
export async function runDuePostTripReviews(
  operatorId: string,
  opts: { afterHours: number; now?: Date; actor?: string },
): Promise<ReviewRunResult> {
  const now = opts.now ?? new Date();
  const endedBefore = new Date(now.getTime() - Math.max(0, opts.afterHours) * 3_600_000);
  const db = forOperator(operatorId);

  const dueIds = await selectDuePostTripOrderIds(db, endedBefore);

  let delivered = 0;
  let noop = 0;
  let smsDelivered = 0;
  for (const orderId of dueIds) {
    // CLAIM this order's review BEFORE sending. The partial unique index on
    // OrderEvent(operator_id, order_id) WHERE type='REVIEW_SENT' lets only one
    // concurrent sweep insert this row; a second sweep loses with P2002 and skips,
    // so an order is never asked twice even if two cron triggers overlap.
    let claimId: string;
    try {
      const claim = await db.orderEvent.create({
        data: {
          operator_id: operatorId,
          order_id: orderId,
          type: REVIEW_EVENT_TYPE,
          description: 'Post-trip review request processing…',
          actor: opts.actor ?? 'system',
          metadata: { delivered: false } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      claimId = claim.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        continue;
      }
      await captureError(err, {
        operatorId,
        route: 'notifications.runDuePostTripReviews',
        extra: { phase: 'claim', order_id: orderId },
      });
      continue;
    }

    // Send both channels on the same pass; each is gated independently by its own
    // provider config (Resend for email, Twilio for SMS) and never throws.
    let email: NotificationResult;
    try {
      email = await sendReviewRequest({ operatorId, orderId });
    } catch (err) {
      await captureError(err, {
        operatorId,
        route: 'notifications.runDuePostTripReviews',
        extra: { channel: 'email', order_id: orderId },
      });
      email = skipped('unexpected failure');
    }

    let sms: NotificationResult;
    try {
      sms = await sendReviewRequestSms({ operatorId, orderId });
    } catch (err) {
      await captureError(err, {
        operatorId,
        route: 'notifications.runDuePostTripReviews',
        extra: { channel: 'sms', order_id: orderId },
      });
      sms = skipped('unexpected failure');
    }

    const anySent = email.sent || sms.sent;
    if (anySent) delivered += 1;
    else noop += 1;
    if (sms.sent) smsDelivered += 1;

    const channels = [email.sent ? 'email' : null, sms.sent ? 'SMS' : null].filter(Boolean);

    try {
      await db.orderEvent.update({
        where: { id: claimId },
        data: {
          description: anySent
            ? `Post-trip review request sent (${channels.join(' + ')})`
            : `Post-trip review request processed (not delivered: email ${email.skippedReason ?? 'n/a'}; sms ${sms.skippedReason ?? 'n/a'})`,
          metadata: {
            delivered: anySent,
            email: { delivered: email.sent, providerId: email.id ?? null, reason: email.skippedReason ?? null },
            sms: { delivered: sms.sent, providerId: sms.id ?? null, reason: sms.skippedReason ?? null },
          } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      await captureError(err, {
        operatorId,
        route: 'notifications.runDuePostTripReviews',
        extra: { phase: 'stamp', order_id: orderId },
      });
    }
  }

  return { operatorId, due: dueIds.length, delivered, noop, smsDelivered };
}

/**
 * Run the post-trip review sweep across every active operator — the entry point the
 * internal HTTP endpoint calls. Iterates operators with the admin client, then does
 * each operator's work through its RLS-scoped tenant client.
 */
export async function runAllDuePostTripReviews(opts: {
  afterHours: number;
  now?: Date;
}): Promise<{ operators: number; due: number; delivered: number; noop: number; smsDelivered: number; perOperator: ReviewRunResult[] }> {
  const operators = await adminPrisma.operator.findMany({
    where: { is_active: true },
    select: { id: true },
  });

  const perOperator: ReviewRunResult[] = [];
  for (const op of operators) {
    // Isolate operators: one operator's failure must not stop reviews for the rest.
    try {
      perOperator.push(await runDuePostTripReviews(op.id, opts));
    } catch (err) {
      await captureError(err, { operatorId: op.id, route: 'notifications.runAllDuePostTripReviews' });
      perOperator.push({ operatorId: op.id, due: 0, delivered: 0, noop: 0, smsDelivered: 0 });
    }
  }

  return {
    operators: operators.length,
    due: perOperator.reduce((n, r) => n + r.due, 0),
    delivered: perOperator.reduce((n, r) => n + r.delivered, 0),
    noop: perOperator.reduce((n, r) => n + r.noop, 0),
    smsDelivered: perOperator.reduce((n, r) => n + r.smsDelivered, 0),
    perOperator,
  };
}
