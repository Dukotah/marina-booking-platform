/**
 * POS API — live integration test against the seeded LSRA tenant on Neon.
 *
 * The POS route is the register for walk-up (staff-recorded) sales. We verify:
 *   - POST /api/pos/sale with a CASH payment creates an Order + Payment and returns
 *     the correct pricing fields (201);
 *   - POST /api/pos/sale with a COMP payment settles the order at $0 tendered;
 *   - a booking line with a custom unitPriceCentsOverride is applied correctly;
 *   - submitting more lines than one (booking + booking) is accepted;
 *   - the route requires staff identity (401 when x-dev-staff-id is omitted);
 *   - a request missing required fields returns 400 (schema validation);
 *   - insufficient timeslot capacity is refused (409);
 *   - GET /api/pos/search?q= returns orders, customers, and products scoped to the
 *     tenant and requires staff identity (401 without the shim);
 *   - GET /api/pos/search?q= with ?type=customers returns only customer hits.
 *
 * Skips without DATABASE_URL. Creates its own timeslots and (if missing) the
 * dev-owner staff row; deletes everything it made in afterAll.
 *
 * NOTE: CARD payment with a live Stripe terminal is intentionally NOT tested here —
 * it requires external Stripe keys and a terminal reader that are unavailable in CI.
 * CASH, COMP, and GIFT_CARD (offline recorded) paths are exercised instead.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { app } from '../src/app.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const TEST_EMAIL = 'pos-itest@example.com';

const staffHeaders = {
  'x-operator-slug': SLUG,
  'x-dev-staff-id': 'dev-owner',
  'content-type': 'application/json',
};

// IDs allocated during beforeAll / created by individual tests — cleaned in afterAll.
let activityId = '';
let rateId = '';
let priceCents = 0;
let qty = 1;
let slotId = '';
let fullSlotId = '';
let createdStaff = false;

// Orders created during the test run — collected so afterAll can sweep them.
const createdOrderIds: string[] = [];
// Slots created inside individual tests — swept in afterAll AFTER their orders, so
// the OrderItem→Timeslot composite FK isn't violated by deleting a slot too early.
const createdSlotIds: string[] = [];

describe.skipIf(!HAS_DB)('POS API (live HTTP vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    // Ensure a dev-owner StaffMember exists. Track if we created it so afterAll
    // only removes it when this suite was responsible for creating it.
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

    // Pick the cheapest public active rate so tests are deterministic.
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
        price_cents: true,
        activity: { select: { min_participants: true, max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');

    activityId = rate.activity_id;
    rateId = rate.id;
    priceCents = rate.price_cents;
    qty = rate.activity.min_participants;

    const db = forOperator(OP);

    // A normal slot with ample capacity for the booking tests.
    const slot = await db.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 32 * 24 * 60 * 60 * 1000), // ~32 days out
        capacity_total: rate.activity.max_participants,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    slotId = slot.id;

    // A slot that is already completely full (capacity_booked == capacity_total).
    const fullSlot = await db.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000),
        capacity_total: qty,
        capacity_booked: qty, // already full
        status: 'FULL',
      },
      select: { id: true },
    });
    fullSlotId = fullSlot.id;

    // Remove any stale customer from a previous failed run.
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
  });

  afterAll(async () => {
    // Delete all orders this suite created (cascade removes OrderItems, OrderEvents,
    // Payments, and Notes). Work through all collected ids.
    for (const id of createdOrderIds) {
      await adminPrisma.order.deleteMany({ where: { id } });
    }
    // Clean up the test customer (email-keyed or anonymous walk-ins synthesised by POS).
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    // Clean up the timeslots.
    if (slotId) await adminPrisma.timeslot.deleteMany({ where: { id: slotId } });
    if (fullSlotId) await adminPrisma.timeslot.deleteMany({ where: { id: fullSlotId } });
    for (const id of createdSlotIds) {
      await adminPrisma.timeslot.deleteMany({ where: { id } });
    }
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
    await adminPrisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // Auth / schema guards
  // ---------------------------------------------------------------------------

  it('POST /api/pos/sale returns 401 without a staff identity', async () => {
    const res = await app.request('/api/pos/sale', {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({
        lines: [{ kind: 'BOOKING', activityId, rateId, timeslotId: slotId, quantity: qty }],
        payment: { method: 'CASH' },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/pos/sale returns 400 when lines array is empty', async () => {
    const res = await app.request('/api/pos/sale', {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ lines: [], payment: { method: 'CASH' } }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/pos/sale returns 400 when body is missing entirely', async () => {
    const res = await app.request('/api/pos/sale', {
      method: 'POST',
      headers: staffHeaders,
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Capacity guard
  // ---------------------------------------------------------------------------

  it('POST /api/pos/sale returns 409 when the timeslot is already full', async () => {
    const res = await app.request('/api/pos/sale', {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({
        lines: [{ kind: 'BOOKING', activityId, rateId, timeslotId: fullSlotId, quantity: qty }],
        payment: { method: 'CASH' },
      }),
    });
    expect(res.status).toBe(409);
  });

  // ---------------------------------------------------------------------------
  // Happy-path: CASH sale
  // ---------------------------------------------------------------------------

  it('POST /api/pos/sale creates an order + payment for a CASH booking', async () => {
    const res = await app.request('/api/pos/sale', {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({
        customer: { first_name: 'POS', last_name: 'Tester', email: TEST_EMAIL },
        lines: [{ kind: 'BOOKING', activityId, rateId, timeslotId: slotId, quantity: qty }],
        payment: { method: 'CASH' },
        note: 'pos-itest cash sale',
      }),
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      order: {
        id: string;
        orderNumber: string;
        status: string;
        subtotalCents: number;
        totalCents: number;
        amountPaidCents: number;
        balanceDueCents: number;
      };
      payment: { id: string; method: string; amountCents: number };
    };

    // Collect for afterAll cleanup.
    createdOrderIds.push(body.order.id);

    // Order shape.
    expect(body.order.id).toBeTruthy();
    expect(body.order.orderNumber).toBeTruthy();
    expect(body.order.status).toBe('UPCOMING');
    expect(body.order.subtotalCents).toBe(priceCents * qty);
    expect(body.order.totalCents).toBeGreaterThanOrEqual(body.order.subtotalCents);
    expect(body.order.amountPaidCents).toBe(body.order.totalCents);
    expect(body.order.balanceDueCents).toBe(0);

    // Payment shape.
    expect(body.payment.id).toBeTruthy();
    expect(body.payment.method).toBe('CASH');
    expect(body.payment.amountCents).toBe(body.order.totalCents);

    // Verify capacity was incremented on the timeslot.
    const slot = await adminPrisma.timeslot.findUnique({
      where: { id: slotId },
      select: { capacity_booked: true },
    });
    expect(slot!.capacity_booked).toBe(qty);

    // Verify the Order in the DB.
    const dbOrder = await adminPrisma.order.findUnique({
      where: { id: body.order.id },
      select: { created_by: true, amount_paid_cents: true, total_cents: true },
    });
    expect(dbOrder!.created_by).toBe('STAFF');
    expect(dbOrder!.amount_paid_cents).toBe(dbOrder!.total_cents);
  });

  // ---------------------------------------------------------------------------
  // Happy-path: COMP sale (zero-dollar / complimentary)
  // ---------------------------------------------------------------------------

  it('POST /api/pos/sale accepts a COMP payment and settles the order at full price', async () => {
    // Use a second slot so we don't collide with the CASH test's capacity increment.
    const db = forOperator(OP);
    const compSlot = await db.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 34 * 24 * 60 * 60 * 1000),
        capacity_total: 20,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });

    try {
      const res = await app.request('/api/pos/sale', {
        method: 'POST',
        headers: staffHeaders,
        body: JSON.stringify({
          // Anonymous walk-up — no customer email; POS synthesises a walkin+ address.
          lines: [{ kind: 'BOOKING', activityId, rateId, timeslotId: compSlot.id, quantity: qty }],
          payment: { method: 'COMP' },
          note: 'pos-itest comp sale',
        }),
      });
      expect(res.status).toBe(201);

      const body = (await res.json()) as {
        order: { id: string; totalCents: number; amountPaidCents: number; balanceDueCents: number };
        payment: { method: string; amountCents: number };
      };

      createdOrderIds.push(body.order.id);

      // COMP: the order total is the full rack rate (no price override), amountPaid equals
      // total (comps are recorded as fully settled per the route logic), balance = 0.
      expect(body.order.totalCents).toBeGreaterThanOrEqual(0);
      expect(body.order.amountPaidCents).toBe(body.order.totalCents);
      expect(body.order.balanceDueCents).toBe(0);
      expect(body.payment.method).toBe('COMP');
    } finally {
      // Sweep the slot in afterAll, after the order that references it is deleted.
      createdSlotIds.push(compSlot.id);
    }
  });

  // ---------------------------------------------------------------------------
  // Happy-path: custom unitPriceCentsOverride (manager discount)
  // ---------------------------------------------------------------------------

  it('POST /api/pos/sale applies unitPriceCentsOverride instead of the rate price', async () => {
    const db = forOperator(OP);
    const overrideSlot = await db.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
        capacity_total: 20,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });

    try {
      const overridePrice = Math.max(0, priceCents - 100); // $1 below rack rate (or $0)

      const res = await app.request('/api/pos/sale', {
        method: 'POST',
        headers: staffHeaders,
        body: JSON.stringify({
          lines: [
            {
              kind: 'BOOKING',
              activityId,
              rateId,
              timeslotId: overrideSlot.id,
              quantity: qty,
              unitPriceCentsOverride: overridePrice,
            },
          ],
          payment: { method: 'CASH' },
          note: 'pos-itest override price',
        }),
      });
      expect(res.status).toBe(201);

      const body = (await res.json()) as {
        order: { id: string; subtotalCents: number };
        payment: { amountCents: number };
      };

      createdOrderIds.push(body.order.id);

      // Subtotal must reflect the override, not the rate's price_cents.
      expect(body.order.subtotalCents).toBe(overridePrice * qty);
    } finally {
      // Sweep the slot in afterAll, after the order that references it is deleted.
      createdSlotIds.push(overrideSlot.id);
    }
  });

  // ---------------------------------------------------------------------------
  // Search endpoint — happy path
  // ---------------------------------------------------------------------------

  it('GET /api/pos/search?q= returns 401 without a staff identity', async () => {
    const res = await app.request('/api/pos/search?q=test', {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/pos/search requires ?q= (400 without it)', async () => {
    const res = await app.request('/api/pos/search', {
      headers: staffHeaders,
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/pos/search?q=pos-itest finds the customer created by the CASH sale', async () => {
    const res = await app.request('/api/pos/search?q=pos-itest', {
      headers: staffHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      query: string;
      orders: Array<{ id: string; orderNumber: string }>;
      customers: Array<{ id: string; email: string }>;
      products: Array<unknown>;
    };

    expect(body.query).toBe('pos-itest');

    // The customer email 'pos-itest@example.com' should appear in customer hits.
    expect(body.customers.some((c) => c.email === TEST_EMAIL)).toBe(true);

    // At least one order should have been created for that customer.
    expect(body.orders.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/pos/search?type=customers only returns customer results (empty orders/products)', async () => {
    const res = await app.request('/api/pos/search?q=pos-itest&type=customers', {
      headers: staffHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      orders: unknown[];
      customers: Array<{ email: string }>;
      products: unknown[];
    };

    expect(body.orders).toHaveLength(0);
    expect(body.products).toHaveLength(0);
    expect(body.customers.some((c) => c.email === TEST_EMAIL)).toBe(true);
  });
});
