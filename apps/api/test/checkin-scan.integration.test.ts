/**
 * QR check-in scan — live HTTP integration test against the seeded LSRA tenant.
 *
 * Exercises the full request path through the real Hono app:
 *   - a valid, correctly-signed token checks the booked item in (CHECKED_IN) and
 *     records a CHECK_IN order event;
 *   - re-scanning is idempotent (alreadyCheckedIn, no duplicate event);
 *   - a TAMPERED token (forged order-item id, original signature) is rejected
 *     with 400 and never changes a booking's status.
 *
 * SKIPS when DATABASE_URL is unset. Creates a disposable booking and cleans it up.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { signCheckinToken } from '@marina/core/checkin-token';
import { app } from '../src/app.js';
import { createBooking } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const TEST_EMAIL = 'checkin-scan-itest@example.com';

const staffHeaders = {
  'x-operator-slug': SLUG,
  'x-dev-staff-id': 'dev-owner',
  'content-type': 'application/json',
};

let timeslotId = '';
let orderId = '';
let orderNumber = '';
let orderItemId = '';
let createdStaff = false;

describe.skipIf(!HAS_DB)('POST /api/checkin/scan (live HTTP vs seed)', () => {
  beforeAll(async () => {
    const existingStaff = await adminPrisma.staffMember.findFirst({
      where: { operator_id: OP, auth_user_id: 'dev-owner' },
      select: { id: true },
    });
    if (!existingStaff) {
      const loc = await adminPrisma.location.findFirst({
        where: { operator_id: OP },
        select: { id: true },
      });
      await adminPrisma.staffMember.create({
        data: {
          operator_id: OP,
          auth_user_id: 'dev-owner',
          name: 'Dev Owner',
          email: 'dev-owner@example.com',
          role: 'OWNER',
          is_active: true,
          locations: loc ? { create: { location_id: loc.id } } : undefined,
        },
      });
      createdStaff = true;
    }

    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true },
      },
      select: {
        id: true,
        activity_id: true,
        activity: { select: { min_participants: true, max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');

    const db = forOperator(OP);
    const slot = await db.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: rate.activity_id,
        datetime: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000),
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
        customer: { first_name: 'Scan', last_name: 'Guest', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    orderId = order.id;
    orderNumber = order.order_number;
    const item = await adminPrisma.orderItem.findFirst({
      where: { order_id: orderId },
      select: { id: true },
    });
    orderItemId = item!.id;
  });

  afterAll(async () => {
    if (orderId) await adminPrisma.order.deleteMany({ where: { id: orderId } });
    if (timeslotId) await adminPrisma.timeslot.deleteMany({ where: { id: timeslotId } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
  });

  it('checks the item in for a valid signed token', async () => {
    const token = signCheckinToken({ orderNumber, orderItemId });
    const res = await app.request('/api/checkin/scan', {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('CHECKED_IN');
    expect(body.alreadyCheckedIn).toBe(false);
    expect(body.orderItemId).toBe(orderItemId);

    const item = await adminPrisma.orderItem.findUnique({
      where: { id: orderItemId },
      select: { status: true },
    });
    expect(item!.status).toBe('CHECKED_IN');

    const events = await adminPrisma.orderEvent.findMany({
      where: { order_id: orderId, type: 'CHECK_IN' },
    });
    expect(events.length).toBe(1);
  });

  it('is idempotent on a re-scan (no duplicate event)', async () => {
    const token = signCheckinToken({ orderNumber, orderItemId });
    const res = await app.request('/api/checkin/scan', {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.alreadyCheckedIn).toBe(true);

    const events = await adminPrisma.orderEvent.findMany({
      where: { order_id: orderId, type: 'CHECK_IN' },
    });
    expect(events.length).toBe(1); // still exactly one
  });

  it('rejects a TAMPERED token (forged item id, original signature)', async () => {
    const good = signCheckinToken({ orderNumber, orderItemId });
    const [body, sig] = good.split('.');
    // Keep the signature; swap the payload to point at a different item id.
    const forgedPayload = { v: 1, on: orderNumber, iid: 'oi_forged_victim' };
    const forgedBody = Buffer.from(JSON.stringify(forgedPayload), 'utf8').toString('base64url');
    expect(forgedBody).not.toBe(body);
    const tampered = `${forgedBody}.${sig}`;

    const res = await app.request('/api/checkin/scan', {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ token: tampered }),
    });
    expect(res.status).toBe(400);
    const resBody = await res.json();
    expect(resBody.ok).toBe(false);
  });

  it('401/403s an unauthenticated scan', async () => {
    const token = signCheckinToken({ orderNumber, orderItemId });
    const res = await app.request('/api/checkin/scan', {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect([401, 403]).toContain(res.status);
  });
});
