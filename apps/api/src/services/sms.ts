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
} from './notification-data.js';
import { sandboxEnabled, captureMessage } from './sandbox.js';
import { captureError } from './errors.js';

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

    const body =
      `${brand.brandName}: booking confirmed for ${facts.activityName} — ${when}` +
      `${facts.partySize > 1 ? `, party of ${facts.partySize}` : ''}. ` +
      `Ref ${order.order_number}.`;

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

    const body =
      `${brand.brandName} reminder: ${facts.activityName} is coming up — ${when}. ` +
      `Please arrive ~${lead} min early. Ref ${order.order_number}.`;

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
