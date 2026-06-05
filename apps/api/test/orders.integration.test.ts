/**
 * Orders API — live HTTP integration test against the seeded LSRA tenant on Neon.
 * Exercises the three roadmap-1.6 routes:
 *
 *   GET  /api/orders          staff list with status/search/pagination filters
 *   GET  /api/orders/:number  public fetch-by-order-number + 404 for unknown
 *   POST /api/orders/:id/cancel  staff cancel with capacity-restoration verification
 *
 * Skips without DATABASE_URL. Creates its own timeslot + booking (+ the dev-owner
 * staff row if missing) and deletes everything it made in afterAll.
 *
 * NOTE: POST /api/orders/:id/refund is NOT tested here — it requires live Stripe
 * keys that are not present in the integration test environment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { app } from '../src/app.js';
import { createBooking } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const TEST_EMAIL = 'orders-itest@example.com';

const staffHeaders = {
  'x-operator-slug': SLUG,
  'x-dev-staff-id': 'dev-owner',
  'content-type': 'application/json',
};
const publicHeaders = { 'x-operator-slug': SLUG };

let timeslotId = '';
let orderId = '';
let orderNumber = '';
let orderQty = 1;
let createdStaff = false;

describe.skipIf(!HAS_DB)('orders API (live HTTP vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    // Ensure dev-owner staff row exists (the dev shim maps x-dev-staff-id → this row).
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

    // Pick the cheapest public rate + activity from the LSRA seed.
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

    orderQty = rate.activity.min_participants;

    // Create a dedicated timeslot well in the future so it doesn't collide with
    // other suites running on the same tenant.
    const slot = await forOperator(OP).timeslot.create({
      data: {
        operator_id: OP,
        activity_id: rate.activity_id,
        datetime: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000), // ~33 days out
        capacity_total: rate.activity.max_participants,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    timeslotId = slot.id;

    // Clean up any leftover customer from a previous interrupted run.
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });

    const order = await createBooking(
      OP,
      {
        activityId: rate.activity_id,
        rateId: rate.id,
        timeslotId,
        quantity: orderQty,
        customer: { first_name: 'Orders', last_name: 'Itest', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    orderId = order.id;
    orderNumber = order.order_number;
  });

  afterAll(async () => {
    if (orderId) await adminPrisma.order.deleteMany({ where: { id: orderId } });
    if (timeslotId) await adminPrisma.timeslot.deleteMany({ where: { id: timeslotId } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
    await adminPrisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // GET /api/orders — staff list
  // ---------------------------------------------------------------------------

  it('GET /api/orders returns a list of orders with pagination metadata (staff)', async () => {
    const res = await app.request('/api/orders', { headers: staffHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orders: Array<{ id: string; orderNumber: string; status: string }>;
      pagination: { total: number; limit: number; offset: number };
    };
    expect(Array.isArray(body.orders)).toBe(true);
    expect(body.pagination.total).toBeGreaterThanOrEqual(1);
    expect(body.pagination.limit).toBeGreaterThanOrEqual(1);
    expect(typeof body.pagination.offset).toBe('number');
    // Our freshly-created order must appear in the unrestricted list.
    expect(body.orders.some((o) => o.id === orderId)).toBe(true);
  });

  it('GET /api/orders requires a staff identity (401 without the shim)', async () => {
    const res = await app.request('/api/orders', { headers: publicHeaders });
    expect(res.status).toBe(401);
  });

  it('GET /api/orders?status=UPCOMING includes the created order', async () => {
    const res = await app.request('/api/orders?status=UPCOMING', { headers: staffHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orders: Array<{ id: string; status: string }>;
      pagination: { total: number };
    };
    expect(body.orders.every((o) => o.status === 'UPCOMING')).toBe(true);
    expect(body.orders.some((o) => o.id === orderId)).toBe(true);
  });

  it('GET /api/orders?status=CANCELLED does NOT include the (still-upcoming) order', async () => {
    const res = await app.request('/api/orders?status=CANCELLED', { headers: staffHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: Array<{ id: string }> };
    expect(body.orders.every((o) => o.id !== orderId)).toBe(true);
  });

  it('GET /api/orders?search=orders-itest finds the order by customer email', async () => {
    const res = await app.request(
      `/api/orders?search=${encodeURIComponent('orders-itest')}`,
      { headers: staffHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: Array<{ id: string }> };
    expect(body.orders.some((o) => o.id === orderId)).toBe(true);
  });

  it('GET /api/orders?search=<order-number> finds the order by order number', async () => {
    const res = await app.request(
      `/api/orders?search=${encodeURIComponent(orderNumber)}`,
      { headers: staffHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: Array<{ id: string }> };
    expect(body.orders.some((o) => o.id === orderId)).toBe(true);
  });

  it('GET /api/orders?search=Itest finds the order by customer last name', async () => {
    const res = await app.request('/api/orders?search=Itest', { headers: staffHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: Array<{ id: string }> };
    expect(body.orders.some((o) => o.id === orderId)).toBe(true);
  });

  it('GET /api/orders pagination: limit=1 returns exactly one row and correct total', async () => {
    const res = await app.request('/api/orders?limit=1&offset=0', { headers: staffHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orders: Array<unknown>;
      pagination: { total: number; limit: number; offset: number };
    };
    expect(body.orders).toHaveLength(1);
    expect(body.pagination.limit).toBe(1);
    expect(body.pagination.offset).toBe(0);
    expect(body.pagination.total).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/orders pagination: offset beyond total returns an empty list', async () => {
    // First get the total, then request an offset beyond it.
    const firstRes = await app.request('/api/orders', { headers: staffHeaders });
    const firstBody = (await firstRes.json()) as { pagination: { total: number } };
    const beyondOffset = firstBody.pagination.total + 1000;

    const res = await app.request(
      `/api/orders?offset=${beyondOffset}`,
      { headers: staffHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: Array<unknown> };
    expect(body.orders).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // GET /api/orders/:orderNumber — public fetch-by-number
  // ---------------------------------------------------------------------------

  it('GET /api/orders/:orderNumber returns the serialized order (public)', async () => {
    const res = await app.request(`/api/orders/${orderNumber}`, { headers: publicHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      order: {
        id: string;
        orderNumber: string;
        status: string;
        customer: { email: string };
        items: Array<{
          quantity: number;
          status: string;
          activity: { id: string; name: string };
          rate: { id: string; name: string };
          timeslot: { id: string };
        }>;
        pagination?: never;
      };
    };
    expect(body.order.id).toBe(orderId);
    expect(body.order.orderNumber).toBe(orderNumber);
    expect(body.order.status).toBe('UPCOMING');
    expect(body.order.customer.email).toBe(TEST_EMAIL);
    expect(body.order.items).toHaveLength(1);
    expect(body.order.items[0]!.quantity).toBe(orderQty);
    expect(body.order.items[0]!.timeslot.id).toBe(timeslotId);
  });

  it('GET /api/orders/:orderNumber returns 404 for an unknown order number', async () => {
    const res = await app.request('/api/orders/UNKNOWN-ORDER-9999', { headers: publicHeaders });
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // POST /api/orders/:id/cancel — staff cancel with capacity restoration
  // ---------------------------------------------------------------------------

  it('POST /api/orders/:id/cancel requires a staff identity (401 without the shim)', async () => {
    // Use publicHeaders (no x-dev-staff-id) — must be rejected before touching anything.
    const res = await app.request(`/api/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/orders/:id/cancel cancels the order and the response shows CANCELLED', async () => {
    // Read the timeslot's capacity_booked before cancelling.
    const slotBefore = await adminPrisma.timeslot.findUnique({
      where: { id: timeslotId },
      select: { capacity_booked: true },
    });
    expect(slotBefore!.capacity_booked).toBe(orderQty); // booking is currently holding this capacity

    const res = await app.request(`/api/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ reason: 'itest cleanup' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      order: {
        id: string;
        status: string;
        items: Array<{ status: string }>;
      };
    };
    expect(body.order.id).toBe(orderId);
    expect(body.order.status).toBe('CANCELLED');
    expect(body.order.items.every((item) => item.status === 'CANCELLED')).toBe(true);
  });

  it('POST /api/orders/:id/cancel restores the timeslot capacity', async () => {
    // After cancellation (previous test), capacity_booked must have been decremented.
    const slotAfter = await adminPrisma.timeslot.findUnique({
      where: { id: timeslotId },
      select: { capacity_booked: true },
    });
    expect(slotAfter!.capacity_booked).toBe(0);
  });

  it('POST /api/orders/:id/cancel is idempotent-guarded: 409 on a second attempt', async () => {
    // The order is already CANCELLED from the previous test — a second cancel must be rejected.
    const res = await app.request(`/api/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ALREADY_CANCELLED');
  });

  it('GET /api/orders?status=CANCELLED now includes the cancelled order', async () => {
    const res = await app.request('/api/orders?status=CANCELLED', { headers: staffHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: Array<{ id: string; status: string }> };
    expect(body.orders.some((o) => o.id === orderId)).toBe(true);
    expect(body.orders.every((o) => o.status === 'CANCELLED')).toBe(true);
  });
});
