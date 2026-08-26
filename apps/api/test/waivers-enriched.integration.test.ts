/**
 * Enriched waiver system — live HTTP integration test against the seeded LSRA
 * tenant. Proves the clause-level signing flow end to end:
 *
 *   - GET /api/waivers/active returns the ordered clauses (with required/initials flags),
 *   - POST /api/waivers/sign with ALL required clauses acknowledged succeeds, stores an
 *     immutable snapshot_html + the acknowledgments JSON, and flips the derived flags,
 *   - POST /api/waivers/sign that omits a required clause is rejected (400), and
 *   - GET /api/waivers/packet (staff) returns the signed packet with snapshot + acks.
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
const SLUG = 'lake-sonoma';
const TEST_EMAIL = 'waiver-enriched-itest@example.com';

const jsonHeaders = { 'x-operator-slug': SLUG, 'content-type': 'application/json' };
const staffHeaders = { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner' };

interface ClauseView {
  id: string;
  title: string;
  requiresInitials: boolean;
  isRequired: boolean;
}

let timeslotId = '';
let orderId = '';
let orderItemId = '';
let clauses: ClauseView[] = [];
let createdStaff = false;

describe.skipIf(!HAS_DB)('enriched waivers API (live HTTP, LSRA seed)', () => {
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

    // Ensure the enriched clauses exist (seed/idempotent script may not have run
    // in this DB); attach them to the active waiver if missing.
    const waiver = await adminPrisma.waiver.findFirst({
      where: { operator_id: OP, is_active: true },
      orderBy: { created_at: 'desc' },
      include: { clauses: true },
    });
    if (!waiver) throw new Error('No active waiver in the LSRA seed — run `pnpm db:seed`.');
    if (waiver.clauses.length === 0) {
      await adminPrisma.waiverClause.createMany({
        data: [
          {
            operator_id: OP,
            waiver_id: waiver.id,
            sort_order: 0,
            title: 'Assumption of Risk (test)',
            body_html: '<p>Risk.</p>',
            requires_initials: true,
            is_required: true,
          },
          {
            operator_id: OP,
            waiver_id: waiver.id,
            sort_order: 1,
            title: 'Photo Release (test, optional)',
            body_html: '<p>Optional.</p>',
            requires_initials: true,
            is_required: false,
          },
        ],
      });
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
        datetime: new Date(Date.now() + 32 * 24 * 60 * 60 * 1000),
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
        customer: { first_name: 'Enriched', last_name: 'Signer', email: TEST_EMAIL },
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

  it('GET /api/waivers/active returns ordered clauses with required/initials flags', async () => {
    const res = await app.request('/api/waivers/active', { headers: { 'x-operator-slug': SLUG } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { waiver: { clauses: ClauseView[] } };
    clauses = body.waiver.clauses;
    expect(clauses.length).toBeGreaterThanOrEqual(2);
    expect(clauses.some((cl) => cl.isRequired)).toBe(true);
    // Sort order preserved.
    const sortOrders = (body.waiver.clauses as Array<{ sortOrder: number }>).map((c) => c.sortOrder);
    expect([...sortOrders].sort((a, b) => a - b)).toEqual(sortOrders);
  });

  it('rejects signing when a required clause is not acknowledged (400)', async () => {
    // Acknowledge only the optional clauses (skip every required one).
    const optionalAcks = clauses
      .filter((cl) => !cl.isRequired)
      .map((cl) => ({ clauseId: cl.id, initials: 'AB' }));

    const res = await app.request('/api/waivers/sign', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        orderItemId,
        signerName: 'Enriched Signer',
        signatureData: 'data:image/png;base64,aGVsbG8=',
        isMinor: false,
        acknowledgments: optionalAcks,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('CLAUSE_NOT_ACKNOWLEDGED');

    // Nothing should have been recorded / flipped.
    const item = await adminPrisma.orderItem.findUnique({
      where: { id: orderItemId },
      select: { waiver_signed: true },
    });
    expect(item!.waiver_signed).toBe(false);
  });

  it('signs with all required clauses acknowledged, storing snapshot + acknowledgments', async () => {
    const acks = clauses
      .filter((cl) => cl.isRequired || cl.requiresInitials)
      .map((cl) => ({ clauseId: cl.id, initials: 'AB' }));

    const res = await app.request('/api/waivers/sign', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        orderItemId,
        signerName: 'Enriched Signer',
        signerDob: '1990-05-01',
        signatureData: 'data:image/png;base64,aGVsbG8=',
        isMinor: false,
        acknowledgments: acks,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      signature: { id: string; acknowledgments: Array<{ clauseId: string; initials: string }> };
    };
    expect(body.signature.acknowledgments.length).toBeGreaterThanOrEqual(
      clauses.filter((c) => c.isRequired).length,
    );

    // The stored row must carry the IMMUTABLE snapshot + acknowledgments JSON + version.
    const row = await adminPrisma.waiverSignature.findUnique({
      where: { id: body.signature.id },
      select: {
        snapshot_html: true,
        acknowledgments: true,
        waiver_version: true,
        signer_dob: true,
      },
    });
    expect(row!.snapshot_html).toBeTruthy();
    expect(row!.snapshot_html).toContain('Signed by');
    expect(row!.waiver_version).not.toBeNull();
    expect(row!.signer_dob).not.toBeNull();
    expect(Array.isArray(row!.acknowledgments)).toBe(true);
    const acksJson = row!.acknowledgments as Array<{ title: string; initials: string }>;
    expect(acksJson[0]).toHaveProperty('title');
    expect(acksJson[0]).toHaveProperty('acknowledgedAt');

    // Derived flags flipped.
    const item = await adminPrisma.orderItem.findUnique({
      where: { id: orderItemId },
      select: { waiver_signed: true },
    });
    expect(item!.waiver_signed).toBe(true);
    const customer = await adminPrisma.customer.findFirst({
      where: { operator_id: OP, email: TEST_EMAIL },
      select: { waiver_on_file: true },
    });
    expect(customer!.waiver_on_file).toBe(true);
  });

  it('GET /api/waivers/packet (staff) returns the signed packet with snapshot data', async () => {
    const res = await app.request(`/api/waivers/packet?orderId=${orderId}`, {
      headers: staffHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      packet: {
        order: { orderNumber: string };
        signatures: Array<{ snapshotHtml: string | null; acknowledgments: unknown[]; signerName: string }>;
      };
    };
    expect(body.packet.order.orderNumber).toBeTruthy();
    expect(body.packet.signatures.length).toBeGreaterThanOrEqual(1);
    const sig = body.packet.signatures[0]!;
    expect(sig.snapshotHtml).toBeTruthy();
    expect(sig.acknowledgments.length).toBeGreaterThanOrEqual(1);
    expect(sig.signerName).toBe('Enriched Signer');
  });

  it('rejects the packet without a staff identity (401)', async () => {
    const res = await app.request(`/api/waivers/packet?orderId=${orderId}`, {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(401);
  });
});
