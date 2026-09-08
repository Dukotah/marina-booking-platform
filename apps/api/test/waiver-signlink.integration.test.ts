/**
 * Pre-arrival waiver sign-link distribution — integration test on the LSRA seed.
 *
 * The standalone signer at {web base}/waiver/{orderItemId} is only useful if
 * something actually hands the guest the link, so this proves the whole chain:
 *
 *   - unsignedWaiverLinks() lists a link for every live waiver-required item
 *     without a signature, and goes quiet once the item is signed,
 *   - the booking-confirmation EMAIL and SMS carry the link while unsigned
 *     (captured via the local sandbox sink — no Resend/Twilio needed), and
 *   - a signed order gets no waiver nag in either channel.
 *
 * Skips without DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { createBooking } from '../src/services/booking.js';
import { loadOrderBundle, unsignedWaiverLinks, waiverSignUrl } from '../src/services/notification-data.js';
import { sendBookingConfirmation } from '../src/services/notifications.js';
import { sendBookingConfirmationSms } from '../src/services/sms.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'waiver-signlink-itest@example.com';

let timeslotId = '';
let orderId = '';
let orderItemId = '';
let waiverRequired = false;
let previousSandbox: string | undefined;

/** E.164 form of the test customer's phone — SMS captures key on it (the SMS
 *  sink stores no order id). */
const TEST_PHONE_E164 = '+17075550142';

async function capturedBodies(kind: string, channel: 'EMAIL' | 'SMS') {
  const rows = await adminPrisma.sandboxMessage.findMany({
    where:
      channel === 'EMAIL'
        ? { operator_id: OP, order_id: orderId, kind, channel }
        : { operator_id: OP, to_address: TEST_PHONE_E164, kind, channel },
    orderBy: { created_at: 'asc' },
    select: { body_html: true, body_text: true },
  });
  return rows.map((r) => `${r.body_html ?? ''}\n${r.body_text ?? ''}`);
}

describe.skipIf(!HAS_DB)('waiver sign-link distribution (LSRA seed)', () => {
  beforeAll(async () => {
    // Capture messages locally instead of sending them.
    previousSandbox = process.env.SANDBOX;
    process.env.SANDBOX = 'local';

    // Rerun-safety: a crashed earlier run may have left captures behind, and the
    // SMS sink keys only on the phone number — stale rows would shadow fresh ones.
    await adminPrisma.sandboxMessage.deleteMany({
      where: { operator_id: OP, to_address: { in: [TEST_PHONE_E164, TEST_EMAIL] } },
    });

    // A waiver-required activity is the whole point here.
    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true, waiver_required: true },
      },
      select: {
        id: true,
        activity_id: true,
        activity: { select: { min_participants: true, max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    waiverRequired = Boolean(rate);
    if (!rate) return; // assertions below skip themselves

    const db = forOperator(OP);
    const slot = await db.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: rate.activity_id,
        datetime: new Date(Date.now() + 34 * 24 * 60 * 60 * 1000),
        capacity_total: rate.activity.max_participants,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    timeslotId = slot.id;

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    const order = await createBooking(
      OP,
      {
        activityId: rate.activity_id,
        rateId: rate.id,
        timeslotId,
        quantity: rate.activity.min_participants,
        customer: {
          first_name: 'Linky',
          last_name: 'Signer',
          email: TEST_EMAIL,
          phone: '707-555-0142',
        },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    orderId = order.id;
    const item = await adminPrisma.orderItem.findFirst({
      where: { order_id: orderId },
      select: { id: true },
    });
    orderItemId = item!.id;
  });

  afterAll(async () => {
    if (previousSandbox === undefined) delete process.env.SANDBOX;
    else process.env.SANDBOX = previousSandbox;

    if (orderId) {
      await adminPrisma.sandboxMessage.deleteMany({
        where: {
          operator_id: OP,
          OR: [{ order_id: orderId }, { to_address: TEST_PHONE_E164 }],
        },
      });
      await adminPrisma.order.deleteMany({ where: { id: orderId } });
    }
    if (timeslotId) await adminPrisma.timeslot.deleteMany({ where: { id: timeslotId } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  it('lists a sign link for the unsigned waiver-required item', async () => {
    if (!waiverRequired) return;
    const bundle = await loadOrderBundle(forOperator(OP), orderId);
    const links = unsignedWaiverLinks(bundle!);
    expect(links).toHaveLength(1);
    expect(links[0]!.url).toBe(waiverSignUrl(orderItemId));
    expect(links[0]!.url).toContain(`/waiver/${orderItemId}`);
    expect(links[0]!.label.length).toBeGreaterThan(0);
  });

  it('puts the sign link in the confirmation email and SMS while unsigned', async () => {
    if (!waiverRequired) return;
    const email = await sendBookingConfirmation({ operatorId: OP, orderId });
    expect(email.sent).toBe(true); // captured by the sandbox sink

    const sms = await sendBookingConfirmationSms({ operatorId: OP, orderId });
    expect(sms.sent).toBe(true);

    const [emailBody] = await capturedBodies('booking_confirmation', 'EMAIL');
    expect(emailBody).toContain(`/waiver/${orderItemId}`);
    expect(emailBody).toContain('Sign your waiver before you arrive');

    const [smsBody] = await capturedBodies('booking_confirmation', 'SMS');
    expect(smsBody).toContain(`/waiver/${orderItemId}`);
  });

  it('drops the waiver nag once the item is signed', async () => {
    if (!waiverRequired) return;
    await adminPrisma.orderItem.update({
      where: { id: orderItemId },
      data: { waiver_signed: true, waiver_signed_at: new Date() },
    });

    const bundle = await loadOrderBundle(forOperator(OP), orderId);
    expect(unsignedWaiverLinks(bundle!)).toHaveLength(0);

    const email = await sendBookingConfirmation({ operatorId: OP, orderId });
    expect(email.sent).toBe(true);
    const bodies = await capturedBodies('booking_confirmation', 'EMAIL');
    const latest = bodies[bodies.length - 1]!;
    expect(latest).not.toContain(`/waiver/${orderItemId}`);
    expect(latest).not.toContain('Sign your waiver before you arrive');
  });
});
