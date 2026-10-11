/**
 * SMS notifications via Twilio — the automation edge over incumbents that have
 * email only (or nothing). Mirrors the email service's resilience contract:
 *
 *  - Config is resolved per-operator from the `Integration` record (key `twilio`,
 *    fields account_sid / auth_token / from_number), falling back to TWILIO_* env
 *    for a single-tenant/dev deployment. If neither is present, sends are a no-op.
 *  - Sends go straight to Twilio's REST API via `fetch` (no SDK dependency).
 *  - Functions NEVER throw. A failed or unconfigured SMS must never break a
 *    booking, payment, or reminder flow — callers get a NotificationResult.
 *    That resilience is the reason every swallowed failure below is also handed
 *    to the error sink: not throwing must not mean not telling anyone, or a dead
 *    SMS path looks exactly like a working one.
 *
 * Tenant-scoped: callers pass the operator id; the order + integration config are
 * loaded through the operator-scoped Prisma client (RLS) so nothing leaks across
 * tenants.
 */

import { forOperator } from '@marina/database';
import {
  type NotificationResult,
  skipped,
  brandFromOperator,
  bookingFacts,
  loadOrderBundle,
  loadCancellationFacts,
  unsignedWaiverLinks,
} from './notification-data.js';
import { formatUSD } from '@marina/core';
import { sandboxEnabled, captureMessage } from './sandbox.js';
import { captureError } from './errors.js';
import { loadTemplateOverride, resolveSmsBody } from './message-templates.js';

// ---------------------------------------------------------------------------
// Twilio config resolution (per-operator Integration → env fallback)
// ---------------------------------------------------------------------------

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

let warnedMissingConfig = false;

function envTwilioConfig(): TwilioConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (accountSid && authToken && fromNumber) return { accountSid, authToken, fromNumber };
  return null;
}

/** Pull a string field out of a stored Integration config JSON blob. */
function configString(config: unknown, key: string): string | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const v = (config as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Resolve Twilio config for an operator: the enabled `twilio` Integration record
 * wins (true multi-tenant — each operator can bring their own Twilio), otherwise
 * the process env, otherwise null (→ no-op).
 */
async function resolveTwilioConfig(operatorId: string): Promise<TwilioConfig | null> {
  try {
    const db = forOperator(operatorId);
    const row = await db.integration.findFirst({
      where: { key: 'twilio', enabled: true },
      select: { config: true },
    });
    const accountSid = configString(row?.config, 'account_sid');
    const authToken = configString(row?.config, 'auth_token');
    const fromNumber = configString(row?.config, 'from_number');
    if (accountSid && authToken && fromNumber) return { accountSid, authToken, fromNumber };
  } catch (err) {
    // Falling through to the env config here means an operator who configured
    // their own Twilio silently sends from the platform's number instead. That
    // is a misconfiguration worth seeing, not a log line.
    await captureError(err, {
      operatorId,
      route: 'sms.resolveTwilioConfig',
      extra: { integration: 'twilio' },
    });
  }
  const env = envTwilioConfig();
  if (!env && !warnedMissingConfig) {
    // Not an error: an unconfigured provider is a supported state (§0 — the
    // product runs with no Twilio account at all), so it warns once and no-ops.
    warnedMissingConfig = true;
    console.warn('[sms] Twilio is not configured (no operator integration or TWILIO_* env) — SMS disabled (no-op).');
  }
  return env;
}

// ---------------------------------------------------------------------------
// Phone normalization + send
// ---------------------------------------------------------------------------

/**
 * Best-effort E.164 normalization. Twilio requires +country-code numbers. We
 * assume US/CA (+1) for 10-digit input, since that's the operator base. Returns
 * null when we can't produce something plausibly dialable.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    return digits.length >= 8 ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** Twilio Messages endpoint for an account. */
function messagesUrl(accountSid: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
}

/**
 * Low-level send. Posts to Twilio's REST API with basic auth. Never throws;
 * returns a NotificationResult. Exported so other flows (POS, marketing) can reuse it.
 */
export async function sendSms(
  operatorId: string,
  to: string | null | undefined,
  body: string,
  /** What this text is, for the Local Console. */
  kind = 'sms',
): Promise<NotificationResult> {
  const e164 = toE164(to);
  if (!e164) return skipped('no valid phone number');

  // Local sandbox: store the text instead of sending it, so SMS is testable
  // with no Twilio account. See services/sandbox.ts.
  if (sandboxEnabled()) {
    return captureMessage({
      operatorId,
      channel: 'SMS',
      kind,
      to: e164,
      text: body,
    });
  }

  const config = await resolveTwilioConfig(operatorId);
  if (!config) return skipped('Twilio not configured');

  try {
    const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
    const form = new URLSearchParams({ To: e164, From: config.fromNumber, Body: body });
    const res = await fetch(messagesUrl(config.accountSid), {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Twilio reports a rejection in the response, not by throwing, so there is
      // no stack to group on. A named Error built here gives the sink a real top
      // frame — otherwise every provider rejection collapses into one anonymous
      // entry with no route back to this call site.
      const providerError = new Error(`Twilio rejected the message (HTTP ${res.status})`);
      providerError.name = 'TwilioError';
      await captureError(providerError, {
        operatorId,
        route: 'sms.sendSms',
        // The recipient number stays out of it; the provider's own diagnostic is
        // truncated and scrubbed on the way in.
        extra: { kind, status: res.status, provider_detail: detail.slice(0, 300) },
      });
      return skipped(`provider error ${res.status}`);
    }
    const data = (await res.json().catch(() => null)) as { sid?: string } | null;
    return { sent: true, id: data?.sid };
  } catch (err) {
    // Network / unexpected failures must never bubble into the caller's flow.
    await captureError(err, { operatorId, route: 'sms.sendSms', extra: { kind } });
    return skipped('unexpected send failure');
  }
}

// ---------------------------------------------------------------------------
// Message composition
// ---------------------------------------------------------------------------

/** Short weekday + month/day for SMS (keeps the message compact). */
function shortDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: timezone,
  }).format(date);
}

// ---------------------------------------------------------------------------
// Public API — booking confirmation + pre-arrival reminder
// ---------------------------------------------------------------------------

/** Text the customer their booking confirmation. Call after an order is created. */
export async function sendBookingConfirmationSms(input: {
  operatorId: string;
  orderId: string;
}): Promise<NotificationResult> {
  try {
    const db = forOperator(input.operatorId);
    const order = await loadOrderBundle(db, input.orderId);
    if (!order) return skipped('order not found');
    if (!order.customer.phone) return skipped('customer has no phone');

    const brand = brandFromOperator(order.operator);
    const facts = bookingFacts(order);
    const when = facts.slotDate
      ? `${shortDate(facts.slotDate, facts.timezone)} at ${facts.timeLabel}`
      : 'see your confirmation';

    // One short sign-link line when a waiver is still outstanding. SMS stays
    // compact: a single link (the first unsigned item) — the signer page and the
    // confirmation email cover multi-item orders in full.
    const waiverLinks = unsignedWaiverLinks(order);
    const waiverLine = waiverLinks.length > 0 ? ` Sign your waiver: ${waiverLinks[0]!.url}` : '';

    const body =
      `${brand.brandName}: booking confirmed for ${facts.activityName} — ${when}` +
      `${facts.partySize > 1 ? `, party of ${facts.partySize}` : ''}. ` +
      `Ref ${order.order_number}.${waiverLine}`;

    return sendSms(input.operatorId, order.customer.phone, body, 'booking_confirmation');
  } catch (err) {
    await captureError(err, {
      operatorId: input.operatorId,
      route: 'sms.sendBookingConfirmationSms',
      extra: { order_id: input.orderId },
    });
    return skipped('unexpected failure');
  }
}

/** Text the customer a pre-arrival reminder. Called from the reminder sweep. */
export async function sendReminderSms(input: {
  operatorId: string;
  orderId: string;
  /** Minutes before start to recommend check-in (default 30). */
  checkInLeadMinutes?: number;
}): Promise<NotificationResult> {
  try {
    const db = forOperator(input.operatorId);
    const order = await loadOrderBundle(db, input.orderId);
    if (!order) return skipped('order not found');
    if (order.status !== 'UPCOMING') return skipped(`order status is ${order.status}`);
    if (!order.customer.phone) return skipped('customer has no phone');

    const brand = brandFromOperator(order.operator);
    const facts = bookingFacts(order);
    const lead = input.checkInLeadMinutes ?? 30;
    const when = facts.slotDate
      ? `${shortDate(facts.slotDate, facts.timezone)} at ${facts.timeLabel}`
      : 'soon';

    const defaultBody =
      `${brand.brandName} reminder: ${facts.activityName} is coming up — ${when}. ` +
      `Please arrive ~${lead} min early. Ref ${order.order_number}.`;

    // Editable message templates: an operator may override the SMS copy for the
    // reminder. A blank/missing/disabled override falls back to the default above.
    const override = await loadTemplateOverride(db, 'BOOKING_REMINDER');
    const { body } = resolveSmsBody({
      defaultBody,
      override,
      facts: {
        order_number: order.order_number,
        activity: facts.activityName,
        date: facts.dateLabel,
        time: facts.timeLabel,
        when,
        lead_minutes: String(lead),
        brand_name: brand.brandName,
      },
    });

    return sendSms(input.operatorId, order.customer.phone, body, 'reminder');
  } catch (err) {
    await captureError(err, {
      operatorId: input.operatorId,
      route: 'sms.sendReminderSms',
      extra: { order_id: input.orderId },
    });
    return skipped('unexpected failure');
  }
}

/**
 * Text the customer that their booking was cancelled. The SMS twin of
 * sendBookingCancellation — fire FIRE-AND-FORGET from the cancel path after
 * commit. Reads the refund amount back off the ORDER_CANCELLED event so the text
 * states what was refunded. Never throws; no-ops when the order/phone/cancel
 * event is missing or the order isn't actually cancelled.
 */
export async function sendBookingCancellationSms(input: {
  operatorId: string;
  orderId: string;
}): Promise<NotificationResult> {
  try {
    const db = forOperator(input.operatorId);
    const order = await loadOrderBundle(db, input.orderId);
    if (!order) return skipped('order not found');
    if (order.status !== 'CANCELLED') return skipped(`order status is ${order.status}`);
    if (!order.customer.phone) return skipped('customer has no phone');

    const refund = await loadCancellationFacts(db, order.id);
    if (!refund) return skipped('no cancellation event');

    const brand = brandFromOperator(order.operator);
    const facts = bookingFacts(order);
    const when = facts.slotDate
      ? `${shortDate(facts.slotDate, facts.timezone)} at ${facts.timeLabel}`
      : 'your booking';
    const refundLine =
      refund.refundCents > 0
        ? ` ${formatUSD(refund.refundCents)} has been refunded.`
        : ' No refund was issued per the cancellation policy.';

    const defaultBody =
      `${brand.brandName}: your booking for ${facts.activityName} — ${when} — has been cancelled.` +
      `${refundLine} Ref ${order.order_number}.`;

    // Editable message templates: an operator may override the SMS copy for the
    // cancellation. A blank/missing/disabled override falls back to the default.
    const override = await loadTemplateOverride(db, 'BOOKING_CANCELLED');
    const { body } = resolveSmsBody({
      defaultBody,
      override,
      facts: {
        order_number: order.order_number,
        refund: formatUSD(refund.refundCents),
        activity: facts.activityName,
        date: facts.dateLabel,
        time: facts.timeLabel,
        when,
        brand_name: brand.brandName,
      },
    });

    return sendSms(input.operatorId, order.customer.phone, body, 'booking_cancelled');
  } catch (err) {
    await captureError(err, {
      operatorId: input.operatorId,
      route: 'sms.sendBookingCancellationSms',
      extra: { order_id: input.orderId },
    });
    return skipped('unexpected failure');
  }
}

/**
 * Text the customer a refund receipt. The SMS twin of sendRefundReceipt — fire
 * FIRE-AND-FORGET after a refund is recorded. Keyed on the payment (like the email
 * twin) so the amount stated is exactly what was refunded. No-ops cleanly when the
 * payment/phone is missing or nothing was refunded. Never throws.
 */
export async function sendRefundReceiptSms(input: {
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
      include: { order: { include: { operator: true, customer: true } } },
    });
    if (!payment) return skipped('payment not found');

    const order = payment.order;
    if (!order.customer.phone) return skipped('customer has no phone');

    const refundedCents = input.refundedCents ?? payment.refunded_cents;
    if (refundedCents <= 0) return skipped('no refunded amount');

    const brand = brandFromOperator(order.operator);

    const defaultBody =
      `${brand.brandName}: a refund of ${formatUSD(refundedCents)} has been issued ` +
      `for order ${order.order_number}. It may take a few business days to appear.`;

    // Editable message templates: an operator may override the SMS copy for the
    // refund receipt. A blank/missing/disabled override falls back to the default.
    const override = await loadTemplateOverride(db, 'REFUND_RECEIPT');
    const { body } = resolveSmsBody({
      defaultBody,
      override,
      facts: {
        order_number: order.order_number,
        refund: formatUSD(refundedCents),
        reason: input.reason ?? 'Refund processed',
        brand_name: brand.brandName,
      },
    });

    return sendSms(input.operatorId, order.customer.phone, body, 'refund_receipt');
  } catch (err) {
    await captureError(err, {
      operatorId: input.operatorId,
      route: 'sms.sendRefundReceiptSms',
      extra: { payment_id: input.paymentId },
    });
    return skipped('unexpected failure');
  }
}

/**
 * Text the customer a post-trip review request. The SMS twin of
 * sendReviewRequest — fired from the review sweep. No-ops when the operator has
 * no review_url configured or the customer has no phone. Never throws.
 */
export async function sendReviewRequestSms(input: {
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
    const reviewUrl = order.operator.review_url?.trim();
    if (!reviewUrl) return skipped('operator has no review_url');
    if (!order.customer.phone) return skipped('customer has no phone');

    const brand = brandFromOperator(order.operator);
    const facts = bookingFacts(order);

    const body =
      `${brand.brandName}: thanks for joining us for ${facts.activityName}! ` +
      `We'd love your feedback — leave a review: ${reviewUrl}`;

    return sendSms(input.operatorId, order.customer.phone, body, 'review_request');
  } catch (err) {
    await captureError(err, {
      operatorId: input.operatorId,
      route: 'sms.sendReviewRequestSms',
      extra: { order_id: input.orderId },
    });
    return skipped('unexpected failure');
  }
}
