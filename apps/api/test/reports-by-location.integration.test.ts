/**
 * Per-location roll-up report — live integration test against the seeded LSRA tenant
 * on Neon. Multi-location chains are the #1 target growth customer (D-002), so the
 * roll-up must attribute bookings + gross to the right site. We verify against real
 * data that:
 *   - buildLocationReport attributes each booking item to its activity's location,
 *     with gross = unit_price_cents * quantity;
 *   - the per-location rows are internally consistent with the roll-up total
 *     (sum of rows == total), regardless of other tenant data in range;
 *   - the HTTP endpoint is report:read-gated (200 for staff, 401 without identity)
 *     and the CSV download carries the TOTAL roll-up row.
 *
 * Creates two fresh locations (each with its own activity/rate/slot/booking) so each
 * location's figures are exactly the booking this test made. Skips without
 * DATABASE_URL; deletes everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { app } from '../src/app.js';
import { createBooking } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const HOUR = 60 * 60 * 1000;
const EMAIL_B = 'loc-b-itest@example.com';
const EMAIL_C = 'loc-c-itest@example.com';

const PRICE_B = 10_000;
const QTY_B = 2;
const PRICE_C = 5_000;
const QTY_C = 1;

let createdStaff = false;
let locB = '';
let locC = '';
let actB = '';
let actC = '';
let rateB = '';
let rateC = '';
let slotB = '';
let slotC = '';
let orderB = '';
let orderC = '';

async function makeLocation(name: string): Promise<string> {
  const loc = await adminPrisma.location.create({
    data: { operator_id: OP, name, is_active: true },
    select: { id: true },
  });
  return loc.id;
}

async function makeActivity(locationId: string, name: string): Promise<string> {
  const act = await adminPrisma.activity.create({
    data: {
      operator_id: OP,
      location_id: locationId,
      name_internal: name,
      name_external: name,
      category: 'OTHER',
      status: 'ACTIVE',
      visible_online: true,
      min_participants: 1,
      max_participants: 10,
      waiver_required: false,
      sort_index: 0,
    },
    select: { id: true },
  });
  return act.id;
}

async function makeRate(activityId: string, priceCents: number): Promise<string> {
  const rate = await adminPrisma.rate.create({
    data: {
      operator_id: OP,
      activity_id: activityId,
      name_internal: 'Full Day',
      name_external: 'Full Day',
      price_cents: priceCents,
      duration_minutes: 480,
      is_active: true,
      internal_only: false,
      sort_index: 0,
    },
    select: { id: true },
  });
  return rate.id;
}

async function makeSlot(activityId: string): Promise<string> {
  const slot = await forOperator(OP).timeslot.create({
    data: {
      operator_id: OP,
      activity_id: activityId,
      datetime: new Date(Date.now() + 2 * HOUR),
      capacity_total: 20,
      capacity_booked: 0,
      status: 'AVAILABLE',
    },
    select: { id: true },
  });
  return slot.id;
}

describe.skipIf(!HAS_DB)('reports: per-location roll-up (live vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    const existingStaff = await adminPrisma.staffMember.findFirst({
      where: { operator_id: OP, auth_user_id: 'dev-owner' },
      select: { id: true },
    });
    if (!existingStaff) {
      const loc = await adminPrisma.location.findFirst({ where: { operator_id: OP }, select: { id: true } });
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

    await adminPrisma.customer.deleteMany({
      where: { operator_id: OP, email: { in: [EMAIL_B, EMAIL_C] } },
    });

    locB = await makeLocation('Roll-up Test Marina B');
    locC = await makeLocation('Roll-up Test Marina C');
    actB = await makeActivity(locB, 'Loc-B Activity');
    actC = await makeActivity(locC, 'Loc-C Activity');
    rateB = await makeRate(actB, PRICE_B);
    rateC = await makeRate(actC, PRICE_C);
    slotB = await makeSlot(actB);
    slotC = await makeSlot(actC);

    const bB = await createBooking(
      OP,
      { activityId: actB, rateId: rateB, timeslotId: slotB, quantity: QTY_B, customer: { first_name: 'Loc', last_name: 'Bee', email: EMAIL_B }, participants: [] },
      { channel: 'CUSTOMER' },
    );
    orderB = bB.id;

    const bC = await createBooking(
      OP,
      { activityId: actC, rateId: rateC, timeslotId: slotC, quantity: QTY_C, customer: { first_name: 'Loc', last_name: 'Cee', email: EMAIL_C }, participants: [] },
      { channel: 'CUSTOMER' },
    );
    orderC = bC.id;
  });

  afterAll(async () => {
    for (const id of [orderB, orderC]) {
      if (id) await adminPrisma.order.deleteMany({ where: { id } }); // cascades to items
    }
    await adminPrisma.timeslot.deleteMany({ where: { id: { in: [slotB, slotC].filter(Boolean) } } });
    await adminPrisma.rate.deleteMany({ where: { id: { in: [rateB, rateC].filter(Boolean) } } });
    await adminPrisma.activity.deleteMany({ where: { id: { in: [actB, actC].filter(Boolean) } } });
    await adminPrisma.location.deleteMany({ where: { id: { in: [locB, locC].filter(Boolean) } } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: { in: [EMAIL_B, EMAIL_C] } } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
    await adminPrisma.$disconnect();
  });

  it('attributes booking gross to each activity location, consistent with the roll-up total', async () => {
    const res = await app.request('/api/reports/by-location', {
      headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: {
        byLocation: Array<{ locationId: string; locationName: string; bookingCount: number; totalQuantity: number; grossCents: number }>;
        total: { bookingCount: number; totalQuantity: number; grossCents: number };
      };
    };
    const { byLocation, total } = body.report;

    const b = byLocation.find((l) => l.locationId === locB);
    expect(b).toBeDefined();
    expect(b!.locationName).toBe('Roll-up Test Marina B');
    expect(b!.grossCents).toBe(PRICE_B * QTY_B); // 20000
    expect(b!.bookingCount).toBe(1);
    expect(b!.totalQuantity).toBe(QTY_B);

    const cc = byLocation.find((l) => l.locationId === locC);
    expect(cc).toBeDefined();
    expect(cc!.grossCents).toBe(PRICE_C * QTY_C); // 5000
    expect(cc!.totalQuantity).toBe(QTY_C);

    // Internal consistency holds regardless of other tenant data in range.
    const rowGross = byLocation.reduce((s, l) => s + l.grossCents, 0);
    const rowCount = byLocation.reduce((s, l) => s + l.bookingCount, 0);
    expect(rowGross).toBe(total.grossCents);
    expect(rowCount).toBe(total.bookingCount);
    expect(total.grossCents).toBeGreaterThanOrEqual(PRICE_B * QTY_B + PRICE_C * QTY_C);
  });

  it('requires a staff identity (401 without the shim)', async () => {
    const res = await app.request('/api/reports/by-location', { headers: { 'x-operator-slug': SLUG } });
    expect(res.status).toBe(401);
  });

  it('CSV download carries the per-location rows and the TOTAL roll-up', async () => {
    const res = await app.request('/api/reports/by-location.csv', {
      headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text).toContain('Roll-up Test Marina B');
    expect(text).toContain('TOTAL (all locations)');
  });
});
