/**
 * Order lookup identity gate (IDOR) — live integration test against the seeded
 * LSRA tenant.
 *
 * `GET /api/orders/:orderNumber` is public, and order numbers are human-facing and
 * enumerable (`<PUBLIC_CODE><YYMMDD><SEQ3>` starting at 001). The route returns the
 * guest's full PII (first/last name, email, phone) and itinerary, so without a
 * second factor an attacker walks the keyspace and harvests every guest. We verify:
 *   - a bare order number (no email) 404s — the PII is NOT returned;
 *   - a WRONG email 404s identically, so the endpoint can't be used to probe which
 *     numbers exist (missing-vs-wrong are indistinguishable, mirroring
 *     self-reschedule);
 *   - the CORRECT email returns the order (the legitimate confirmation/lookup flow);
 *   - authenticated staff (dev shim) read the order WITHOUT an email — the admin path.
 *
 * Skips without DATABASE_URL. Creates its own booking + staff row and deletes
 * everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { app } from '../src/app.js';
import { createBooking } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const EMAIL = 'idor-lookup-itest@example.com';
const DAY = 24 * 60 * 60 * 1000;

let orderId = '';
let orderNumber = '';
let slotId = '';
let createdStaff = false;

describe.skipIf(!HAS_DB)('order lookup identity gate (live vs LSRA seed)', () => {
  beforeAll(async () => {
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

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: EMAIL } });

    const slot = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: rate.activity_id,
        datetime: new Date(Date.now() + 40 * DAY),
        capacity_total: rate.activity.max_participants,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    slotId = slot.id;

    const order = await createBooking(
      OP,
      {
        activityId: rate.activity_id,
        rateId: rate.id,
        timeslotId: slotId,
        quantity: rate.activity.min_participants,
        customer: { first_name: 'Id', last_name: 'Or', email: EMAIL, phone: '555-0100' },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    orderId = order.id;
    orderNumber = order.order_number;

    // The dev shim resolves `x-dev-staff-id: dev-owner` to this staff row.
    const existing = await adminPrisma.staffMember.findFirst({
      where: { operator_id: OP, auth_user_id: 'dev-owner' },
      select: { id: true },
    });
    if (!existing) {
      await adminPrisma.staffMember.create({
        data: {
          operator_id: OP,
          auth_user_id: 'dev-owner',
          name: 'Dev Owner',
          email: 'dev-owner-idor-itest@example.com',
          role: 'OWNER',
          is_active: true,
        },
      });
      createdStaff = true;
    }
  });

  afterAll(async () => {
    if (orderId) await adminPrisma.order.deleteMany({ where: { id: orderId } });
    if (slotId) await adminPrisma.timeslot.deleteMany({ where: { id: slotId } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: EMAIL } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({
        where: { operator_id: OP, auth_user_id: 'dev-owner' },
      });
    }
    await adminPrisma.$disconnect();
  });

  it('404s a bare order number with no identity proof (no PII leak)', async () => {
    const res = await app.request(`/api/orders/${orderNumber}`, {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    // The response must not carry the guest's PII.
    expect(JSON.stringify(body)).not.toContain(EMAIL);
    expect(JSON.stringify(body)).not.toContain('555-0100');
    expect(body.order).toBeUndefined();
  });

  it('404s a wrong email identically (no existence oracle)', async () => {
    const res = await app.request(
      `/api/orders/${orderNumber}?email=${encodeURIComponent('not-the-booker@example.com')}`,
      { headers: { 'x-operator-slug': SLUG } },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(EMAIL);
    expect(body.order).toBeUndefined();
  });

  it('returns the order to a caller who proves the matching email', async () => {
    const res = await app.request(
      `/api/orders/${orderNumber}?email=${encodeURIComponent(EMAIL.toUpperCase())}`,
      { headers: { 'x-operator-slug': SLUG } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order.orderNumber).toBe(orderNumber);
    expect(body.order.customer.email).toBe(EMAIL);
  });

  it('lets authenticated staff read the order without an email', async () => {
    const res = await app.request(`/api/orders/${orderNumber}`, {
      headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order.orderNumber).toBe(orderNumber);
    expect(body.order.customer.email).toBe(EMAIL);
  });
});
