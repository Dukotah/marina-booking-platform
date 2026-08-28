/**
 * Local sandbox message sink.
 *
 * The product has to be exercisable end to end with no Resend and no Twilio
 * account (docs/LOCAL-FIRST-BUILD.md §0). Rather than no-op the notification
 * path when a provider key is missing — which hides bugs and makes "did it send
 * the right thing?" unanswerable — we render the message exactly as it would be
 * sent and store it. The Local Console (/dev in the admin app) reads it back.
 *
 * Failure policy matches the providers it stands in for: capture NEVER throws.
 * A sandbox write failing must not break a booking any more than Twilio being
 * down would.
 */
import { forOperator } from '@marina/database';
import { type NotificationResult, skipped } from './notification-data.js';

/**
 * Is the sandbox sink active?
 *
 *   SANDBOX=local  -> always on
 *   SANDBOX=cloud  -> always off (real providers only)
 *   unset          -> on outside production
 *
 * The unset default is deliberately off in production: a deploy that forgets to
 * set SANDBOX must fail loudly by not sending, never silently swallow a real
 * customer's confirmation into a dev table.
 */
export function sandboxEnabled(): boolean {
  const flag = process.env.SANDBOX?.trim().toLowerCase();
  if (flag === 'local') return true;
  if (flag === 'cloud') return false;
  return process.env.NODE_ENV !== 'production';
}

/**
 * Postgres text columns cannot hold a NUL byte (0x00) — it rejects the whole
 * statement with `invalid byte sequence for encoding "UTF8"`, which reads like a
 * corrupt payload and is impossible to trace back to a field. A NUL is never
 * meaningful content in a rendered email or a text message, so strip it rather than
 * lose the message.
 *
 * This is not hypothetical: a NUL in one rendered staff-alert body silently ate
 * every staff "new booking" email while the guest's own confirmation went out fine,
 * so the operator was never told about bookings and nothing surfaced but a log line.
 * The offending field is named once per call so the source stays findable.
 */
function stripNul(value: string | null | undefined, field: string, seen: string[]): string | null {
  if (value == null) return null;
  if (!value.includes('\u0000')) return value;
  seen.push(field);
  return value.replace(/\u0000/g, '');
}

export interface CaptureArgs {
  operatorId: string;
  channel: 'EMAIL' | 'SMS';
  /** What this message is, e.g. booking_confirmation, reminder, refund_receipt. */
  kind: string;
  to: string;
  from?: string | null;
  subject?: string | null;
  html?: string | null;
  text?: string | null;
  orderId?: string | null;
  orderNumber?: string | null;
}

/**
 * Store one message. Returns a NotificationResult so a caller can return it
 * directly in place of the provider's result.
 */
export async function captureMessage(args: CaptureArgs): Promise<NotificationResult> {
  try {
    const db = forOperator(args.operatorId);
    const dirty: string[] = [];
    const row = await db.sandboxMessage.create({
      data: {
        operator_id: args.operatorId,
        channel: args.channel,
        kind: args.kind,
        to_address: stripNul(args.to, 'to', dirty) ?? '',
        from_address: stripNul(args.from, 'from', dirty),
        subject: stripNul(args.subject, 'subject', dirty),
        body_html: stripNul(args.html, 'html', dirty),
        body_text: stripNul(args.text, 'text', dirty),
        order_id: args.orderId ?? null,
        order_number: args.orderNumber ?? null,
      },
      select: { id: true },
    });
    if (dirty.length > 0) {
      console.warn(
        `[sandbox] stripped NUL bytes from ${args.kind} (${args.channel}): ${dirty.join(', ')}`,
      );
    }
    return { sent: true, id: row.id };
  } catch (err) {
    console.error('[sandbox] capture failed:', err);
    return skipped('sandbox capture failed');
  }
}
