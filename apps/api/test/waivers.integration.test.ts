/**
 * Waivers API — live HTTP integration test against the seeded LSRA tenant on Neon.
 * Unlike the booking/availability suites (which call services directly), this drives
 * the real Hono app via `app.request(...)`, so it exercises the FULL request path:
 * tenant resolution middleware -> RLS-scoped client -> zod validation -> handler ->
 * the dev-staff auth shim for the staff-only route.
 *
 * Waiver capture + audit trail is on the go-live checklist, so we prove:
 *   - POST /api/waivers/sign records a signature, flips the order item's waiver flags
 *     and the customer's waiver_on_file (all in one transaction),
 *   - a minor signature without a guardian is rejected (400),
 *   - GET /api/waivers/active returns the tenant's active template, and
 *   - GET /api/waivers (staff) lists the order's signatures.
 *
 * Skips without DATABASE_URL. Creates its own booking + (if missing) the dev-owner
 * staff row, and deletes everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { app } from '../src/app.js';
import { createBooking } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma'; // operator.slug -> resolves to operator id 'lsra'
const TEST_EMAIL = 'waiver-itest@example.com';

const jsonHeaders = { 'x-operator-slug': SLUG, 'content-type': 'application/json' };

let timeslotId = '';
let orderId = '';
let orderItemId = '';
let createdStaff = false;

describe.skipIf(!HAS_DB)('waivers API (live HTTP vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    // Ensure a dev-owner staff member exists for the staff-only GET (the dev shim
    // resolves `x-dev-staff-id: dev-owner` to this row). Track if we created it.
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

    // Create a booking so we have an order item to sign for.
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
        datetime: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
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
        customer: { first_name: 'Waiver', last_name: 'Signer', email: TEST_EMAIL },
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
    // WaiverSignature -> OrderItem/Customer FKs are non-cascading, so clear signatures
    // before deleting the order (whose cascade removes the items) and the customer.
    const cust = await adminPrisma.customer.findFirst({
      where: { operator_id: OP, email: TEST_EMAIL },
      select: { id: true },
    });
    if (cust) {
      await adminPrisma.waiverSignature.deleteMany({ where: { operator_id: OP, customer_id: cust.id } });
    }
    if (orderId) await adminPrisma.order.deleteMany({ where: { id: orderId } });
    if (timeslotId) await adminPrisma.timeslot.deleteMany({ where: { id: timeslotId } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
    await adminPrisma.$disconnect();
  });

  it('GET /api/waivers/active returns the tenant active waiver template', async () => {
    const res = await app.request('/api/waivers/active', { headers: { 'x-operator-slug': SLUG } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { waiver: { id: string; templateHtml: string } };
    expect(body.waiver.id).toBeTruthy();
    expect(typeof body.waiver.templateHtml).toBe('string');
  });

  it('POST /api/waivers/sign records the signature and flips the derived flags', async () => {
    const res = await app.request('/api/waivers/sign', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        orderItemId,
        signerName: 'Waiver Signer',
        signatureData: 'data:image/png;base64,aGVsbG8=',
        isMinor: false,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { signature: { id: string; orderItemId: string } };
    expect(body.signature.orderItemId).toBe(orderItemId);

    // Derived flags must have flipped in the same transaction.
    const item = await adminPrisma.orderItem.findUnique({
      where: { id: orderItemId },
      select: { waiver_signed: true, waiver_signed_at: true },
    });
    expect(item!.waiver_signed).toBe(true);
    expect(item!.waiver_signed_at).not.toBeNull();

    const customer = await adminPrisma.customer.findFirst({
      where: { operator_id: OP, email: TEST_EMAIL },
      select: { waiver_on_file: true },
    });
    expect(customer!.waiver_on_file).toBe(true);
  });

  it('rejects a minor signature with no guardian (400)', async () => {
    const res = await app.request('/api/waivers/sign', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        orderItemId,
        signerName: 'Junior',
        signatureData: 'data:image/png;base64,aGVsbG8=',
        isMinor: true,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/waivers (staff) lists the order signatures via the dev-staff shim', async () => {
    const res = await app.request(`/api/waivers?orderId=${orderId}`, {
      headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signatures: Array<{ orderItemId: string }> };
    expect(body.signatures.length).toBeGreaterThanOrEqual(1);
    expect(body.signatures.some((s) => s.orderItemId === orderItemId)).toBe(true);
  });

  it('rejects the staff list without a staff identity (401)', async () => {
    const res = await app.request(`/api/waivers?orderId=${orderId}`, {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(401);
  });
});
