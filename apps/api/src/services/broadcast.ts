/**
 * Staff broadcast / direct message service — "tell the guests on this departure
 * something" (weather hold, dock moved, running late) and "message one guest".
 *
 * This is the staff-authored twin of the transactional notifications: instead of
 * a templated booking/refund email, a staffer types a short free-text message and
 * it goes to every live booking on a timeslot (broadcast) or to one order's guest
 * (direct). Both reuse the SAME resilience contract and choke points as the rest
 * of the messaging stack:
 *   - email goes through notifications.sendOperatorMessageEmail (the Resend
 *     dispatch choke point — sandbox capture, white-label from-address, never
 *     throws);
 *   - SMS goes through sms.sendSms (Twilio choke point — E.164 normalize, sandbox
 *     capture, never throws).
 *
 * Tenant-scoped: callers pass the operator id; every record is loaded through the
 * operator-scoped Prisma client (RLS) so nothing leaks across tenants. Nothing here
 * throws for a delivery failure — a guest with no email/phone is simply skipped and
 * counted, so one bad contact never fails the whole broadcast.
 *
 * "Live booking" = an order item that is NOT cancelled and whose order is not
 * cancelled, on the given timeslot. A no-show / checked-in guest can still be
 * messaged (they are on the trip); only a cancelled seat is excluded.
 */
import { forOperator } from '@marina/database';
import { brandFromOperator, fullName } from './notification-data.js';
import { sendOperatorMessageEmail } from './notifications.js';
import { sendSms } from './sms.js';
import { captureError } from './errors.js';

/** A typed, user-facing failure the route maps to a clean HTTP status. */
export class BroadcastError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

/** Which channels a broadcast/message should attempt. At least one must be true. */
export interface MessageChannels {
  email: boolean;
  sms: boolean;
}

export interface MessageResult {
  /** How many distinct guests (orders) the message was addressed to. */
  recipients: number;
  /** Of those, how many had at least one channel actually dispatch. */
  delivered: number;
  /** How many real emails dispatched. */
  emailsSent: number;
  /** How many real texts dispatched. */
  smsSent: number;
}

const MAX_MESSAGE_LENGTH = 1000;

/** Validate + normalize the staff-authored body. Throws BroadcastError on bad input. */
function normalizeBody(raw: string): string {
  const body = (raw ?? '').trim();
  if (!body) throw new BroadcastError('EMPTY_MESSAGE', 'Write the message first.');
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new BroadcastError(
      'MESSAGE_TOO_LONG',
      `Keep the message under ${MAX_MESSAGE_LENGTH} characters.`,
    );
  }
  return body;
}

function assertAChannel(channels: MessageChannels): void {
  if (!channels.email && !channels.sms) {
    throw new BroadcastError('NO_CHANNEL', 'Pick at least one way to reach them (email or text).');
  }
}

/** One guest to reach: the order's contact details + a subject-worthy name. */
interface Recipient {
  orderId: string;
  orderNumber: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}

/**
 * Send one staff-authored message to one recipient across the requested channels.
 * Returns which channels actually dispatched. Never throws — a dead channel is
 * counted as not-delivered, not an error.
 */
async function sendToRecipient(input: {
  operatorId: string;
  brandName: string;
  subject: string;
  body: string;
  channels: MessageChannels;
  recipient: Recipient;
}): Promise<{ emailSent: boolean; smsSent: boolean }> {
  const { operatorId, brandName, subject, body, channels, recipient } = input;
  let emailSent = false;
  let smsSent = false;

  if (channels.email && recipient.email) {
    const greetingName = recipient.firstName || 'Guest';
    const res = await sendOperatorMessageEmail({
      operatorId,
      brandName,
      to: recipient.email,
      guestName: greetingName,
      subject,
      body,
      orderId: recipient.orderId,
      orderNumber: recipient.orderNumber,
    });
    emailSent = res.sent;
  }

  if (channels.sms && recipient.phone) {
    // SMS carries the brand prefix so the guest knows who it is from; the staff
    // body is sent verbatim (no templating — it is already what they want said).
    const smsBody = `${brandName}: ${body}`;
    const res = await sendSms(operatorId, recipient.phone, smsBody, 'operator_message');
    smsSent = res.sent;
  }

  return { emailSent, smsSent };
}

function tallyAcross(
  results: Array<{ emailSent: boolean; smsSent: boolean }>,
  recipients: number,
): MessageResult {
  let delivered = 0;
  let emailsSent = 0;
  let smsSent = 0;
  for (const r of results) {
    if (r.emailSent) emailsSent += 1;
    if (r.smsSent) smsSent += 1;
    if (r.emailSent || r.smsSent) delivered += 1;
  }
  return { recipients, delivered, emailsSent, smsSent };
}

/**
 * Broadcast a staff-authored message to every live booking on a timeslot. Loads
 * the slot (tenant-scoped) to confirm it exists and to title the default subject,
 * then messages each non-cancelled order's guest once (deduped by order, so a
 * multi-item order's guest is not texted twice).
 */
export async function broadcastToTimeslot(
  operatorId: string,
  input: { timeslotId: string; body: string; channels: MessageChannels; subject?: string },
): Promise<MessageResult> {
  assertAChannel(input.channels);
  const body = normalizeBody(input.body);

  const db = forOperator(operatorId);

  const slot = await db.timeslot.findUnique({
    where: { id: input.timeslotId },
    select: {
      id: true,
      activity: { select: { name_external: true, name_internal: true } },
    },
  });
  if (!slot) throw new BroadcastError('TIMESLOT_NOT_FOUND', 'That departure could not be found', 404);

  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { name_external: true, brand_color: true, logo_light_url: true, logo_dark_url: true },
  });
  const brandName = operator ? brandFromOperator(operator).brandName : 'Your trip';

  const activityName = slot.activity.name_external || slot.activity.name_internal || 'your trip';
  const subject = (input.subject?.trim() || `A message about your ${activityName}`).slice(0, 200);

  // Every live item on the slot, with its order's contact details. One row per
  // order so the same guest booked on two items is messaged once.
  const items = await db.orderItem.findMany({
    where: {
      timeslot_id: input.timeslotId,
      status: { not: 'CANCELLED' },
      order: { status: { not: 'CANCELLED' } },
    },
    select: {
      order: {
        select: {
          id: true,
          order_number: true,
          customer: { select: { first_name: true, last_name: true, email: true, phone: true } },
        },
      },
    },
  });

  const byOrder = new Map<string, Recipient>();
  for (const it of items) {
    const o = it.order;
    if (byOrder.has(o.id)) continue;
    byOrder.set(o.id, {
      orderId: o.id,
      orderNumber: o.order_number,
      firstName: o.customer.first_name,
      lastName: o.customer.last_name,
      email: o.customer.email ?? null,
      phone: o.customer.phone ?? null,
    });
  }
  const recipients = Array.from(byOrder.values());

  const results: Array<{ emailSent: boolean; smsSent: boolean }> = [];
  for (const recipient of recipients) {
    try {
      results.push(
        await sendToRecipient({ operatorId, brandName, subject, body, channels: input.channels, recipient }),
      );
    } catch (err) {
      // sendToRecipient never throws, but guard the loop anyway so one bad
      // recipient can never abort the rest of the broadcast.
      await captureError(err, {
        operatorId,
        route: 'broadcast.broadcastToTimeslot',
        extra: { timeslot_id: input.timeslotId, order_id: recipient.orderId },
      });
      results.push({ emailSent: false, smsSent: false });
    }
  }

  return tallyAcross(results, recipients.length);
}

/**
 * Message one guest (the order's customer) a staff-authored note. Tenant-scoped;
 * reuses the same channels and choke points as the broadcast.
 */
export async function messageOrderGuest(
  operatorId: string,
  input: { orderId: string; body: string; channels: MessageChannels; subject?: string },
): Promise<MessageResult> {
  assertAChannel(input.channels);
  const body = normalizeBody(input.body);

  const db = forOperator(operatorId);

  const order = await db.order.findUnique({
    where: { id: input.orderId },
    select: {
      id: true,
      order_number: true,
      status: true,
      customer: { select: { first_name: true, last_name: true, email: true, phone: true } },
      operator: {
        select: { name_external: true, brand_color: true, logo_light_url: true, logo_dark_url: true },
      },
    },
  });
  if (!order) throw new BroadcastError('ORDER_NOT_FOUND', 'That order could not be found', 404);

  const brandName = brandFromOperator(order.operator).brandName || 'Your trip';
  const guestName = fullName(order.customer.first_name, order.customer.last_name) || 'Guest';
  const subject = (input.subject?.trim() || `A message about your booking ${order.order_number}`).slice(
    0,
    200,
  );

  const recipient: Recipient = {
    orderId: order.id,
    orderNumber: order.order_number,
    firstName: order.customer.first_name,
    lastName: order.customer.last_name,
    email: order.customer.email ?? null,
    phone: order.customer.phone ?? null,
  };

  if (!recipient.email && !recipient.phone) {
    throw new BroadcastError('NO_CONTACT', `${guestName} has no email or phone on file.`);
  }

  const result = await sendToRecipient({
    operatorId,
    brandName,
    subject,
    body,
    channels: input.channels,
    recipient,
  });

  return tallyAcross([result], 1);
}
