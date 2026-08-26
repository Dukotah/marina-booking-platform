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
    const row = await db.sandboxMessage.create({
      data: {
        operator_id: args.operatorId,
        channel: args.channel,
        kind: args.kind,
        to_address: args.to,
        from_address: args.from ?? null,
        subject: args.subject ?? null,
        body_html: args.html ?? null,
        body_text: args.text ?? null,
        order_id: args.orderId ?? null,
        order_number: args.orderNumber ?? null,
      },
      select: { id: true },
    });
    return { sent: true, id: row.id };
  } catch (err) {
    console.error('[sandbox] capture failed:', err);
    return skipped('sandbox capture failed');
  }
}
