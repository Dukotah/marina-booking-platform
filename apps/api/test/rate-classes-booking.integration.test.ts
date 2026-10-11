/**
 * Per-head rate classes — live integration test against the seeded Lake Sonoma
 * (LSRA) tenant. Proves the server-authoritative per-class money path end-to-end:
 *
 *   - POST-equivalent createBooking accepts a rateClasses[] participant breakdown
 *     and prices each class SERVER-SIDE (base price + the class's own modifier,
 *     clamped >= 0), with the quote shown == the amount charged;
 *   - it writes one seat OrderItem per class with its own quantity + per-head
 *     unit_price_cents + rate_class label snapshot, so manifest/reports (which sum
 *     quantity * unit_price_cents off OrderItem) still work with the totals;
 *   - effective quantity = sum of class counts (ignores the client `quantity`);
 *   - TAMPER: an unknown/forged class id is REFUSED (never priced at the base), and
 *     the failed attempt moves no capacity.
 *
 * SKIPS when DATABASE_URL is unset so plain `pnpm test` stays green pre-Neon. It
 * creates its own disposable rate + classes + timeslot + customer and deletes
 * everything it made in afterAll, so it never pollutes the seed tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { calculatePricing, type PricingFee } from '@marina/core';
import { createBooking, BookingError } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'rate-classes-itest@example.com';
const BASE_CENTS = 10000; // $100 base per head on our disposable rate.

interface Fixture {
  activityId: string;
  rateId: string;
  timeslotId: string;
  adultClassId: string;
  childClassId: string;
}

let fx: Fixture;
const createdOrderIds: string[] = [];

/** Server-side fees for the activity, shaped for @marina/core (mirrors booking.ts). */
async function loadFees(activityId: string): Promise<PricingFee[]> {
  const rows = await adminPrisma.fee.findMany({
    where: { operator_id: OP, enabled: true, OR: [{ activity_id: activityId }, { activity_id: null }] },
    select: { name: true, type: true, value: true },
  });
  return rows.map((f) => ({ name: f.name, type: f.type, value: f.value }));
}

describe.skipIf(!HAS_DB)('rate classes (live vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    // An active, online activity with headroom for a mixed party.
    const activity = await adminPrisma.activity.findFirst({
      where: { operator_id: OP, status: 'ACTIVE', visible_online: true, max_participants: { gte: 4 } },
      select: { id: true },
    });
    if (!activity) throw new Error('No activity with capacity >= 4 in the LSRA seed.');

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });

    const db = forOperator(OP);
    // A disposable rate so we fully control the base price + classes.
    const rate = await db.rate.create({
      data: {
        operator_id: OP,
        activity_id: activity.id,
        name_internal: 'ratecls-itest-rate',
        name_external: 'Rate Class Test',
        price_cents: BASE_CENTS,
        duration_minutes: 120,
        is_active: true,
      },
      select: { id: true },
    });
    const adult = await db.rateClass.create({
      data: {
        operator_id: OP,
        rate_id: rate.id,
        kind: 'ADULT',
        label: 'Adult',
        price_modifier_cents: 0,
      },
      select: { id: true },
    });
    const child = await db.rateClass.create({
      data: {
        operator_id: OP,
        rate_id: rate.id,
        kind: 'CHILD',
        label: 'Child',
        price_modifier_cents: -2500, // $25 off per child.
      },
      select: { id: true },
    });

    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const slot = await db.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activity.id,
        datetime: future,
        capacity_total: 10,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });

    fx = {
      activityId: activity.id,
      rateId: rate.id,
      timeslotId: slot.id,
      adultClassId: adult.id,
      childClassId: child.id,
    };
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await adminPrisma.order.deleteMany({ where: { id } });
    if (fx?.timeslotId) await adminPrisma.timeslot.deleteMany({ where: { id: fx.timeslotId } });
    // Deleting the rate cascades its RateClasses.
    if (fx?.rateId) await adminPrisma.rate.deleteMany({ where: { id: fx.rateId } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  it('prices a mixed party per class server-side (quote == charge) and writes one item per class', async () => {
    // 2 adults ($100 ea) + 1 child ($75) = $275 subtotal before fees.
    const order = await createBooking(
      OP,
      {
        activityId: fx.activityId,
        rateId: fx.rateId,
        timeslotId: fx.timeslotId,
        // This client quantity must be IGNORED — the class counts are authoritative.
        quantity: 99,
        customer: { first_name: 'Rate', last_name: 'Classer', email: TEST_EMAIL },
        participants: [],
        rateClasses: [
          { classId: fx.adultClassId, count: 2 },
          { classId: fx.childClassId, count: 1 },
        ],
      },
      { channel: 'CUSTOMER', actor: 'rate-classes.integration.test' },
    );
    createdOrderIds.push(order.id);

    // The server-authoritative quote: two priced seat lines through @marina/core.
    const expected = calculatePricing({
      items: [
        { unitPriceCents: BASE_CENTS, quantity: 2 },
        { unitPriceCents: BASE_CENTS - 2500, quantity: 1 },
      ],
      fees: await loadFees(fx.activityId),
      promo: null,
      tipCents: 0,
    });
    expect(order.subtotal_cents).toBe(expected.subtotalCents);
    expect(order.subtotal_cents).toBe(27500);
    expect(order.total_cents).toBe(expected.totalCents);
    // Quote == charge: the balance due (unpaid at creation) is exactly the total.
    expect(order.balance_due_cents).toBe(expected.totalCents);

    // One seat OrderItem per class, each with its own per-head price + label.
    const items = await adminPrisma.orderItem.findMany({
      where: { order_id: order.id, rate_class_id: { not: null } },
      orderBy: { unit_price_cents: 'desc' },
    });
    expect(items).toHaveLength(2);
    expect(items[0]!.rate_class_id).toBe(fx.adultClassId);
    expect(items[0]!.quantity).toBe(2);
    expect(items[0]!.unit_price_cents).toBe(BASE_CENTS);
    expect(items[0]!.rate_class_label).toBe('Adult');
    expect(items[1]!.rate_class_id).toBe(fx.childClassId);
    expect(items[1]!.quantity).toBe(1);
    expect(items[1]!.unit_price_cents).toBe(BASE_CENTS - 2500);
    expect(items[1]!.rate_class_label).toBe('Child');

    // Manifest/reports read quantity * unit_price_cents off OrderItem — it reconciles.
    const seatSum = items.reduce((s, i) => s + i.quantity * i.unit_price_cents, 0);
    expect(seatSum).toBe(27500);

    // Effective quantity = sum of counts = 3, NOT the client's 99.
    const slot = await adminPrisma.timeslot.findUnique({ where: { id: fx.timeslotId } });
    expect(slot!.capacity_booked).toBe(3);
  });

  it('TAMPER: refuses an unknown/forged class id and moves no capacity', async () => {
    const before = await adminPrisma.timeslot.findUnique({ where: { id: fx.timeslotId } });
    await expect(
      createBooking(
        OP,
        {
          activityId: fx.activityId,
          rateId: fx.rateId,
          timeslotId: fx.timeslotId,
          quantity: 1,
          customer: { first_name: 'Tamper', last_name: 'Classer', email: TEST_EMAIL },
          participants: [],
          rateClasses: [{ classId: 'forged-class-id', count: 3 }],
        },
        { channel: 'CUSTOMER' },
      ),
    ).rejects.toThrow(BookingError);

    const after = await adminPrisma.timeslot.findUnique({ where: { id: fx.timeslotId } });
    expect(after!.capacity_booked).toBe(before!.capacity_booked);
  });

  it('keeps single-quantity bookings working (synthesized default Guest class)', async () => {
    const order = await createBooking(
      OP,
      {
        activityId: fx.activityId,
        rateId: fx.rateId,
        timeslotId: fx.timeslotId,
        quantity: 2,
        customer: { first_name: 'Single', last_name: 'Qty', email: TEST_EMAIL },
        participants: [],
        // No rateClasses -> single-quantity path.
      },
      { channel: 'CUSTOMER' },
    );
    createdOrderIds.push(order.id);

    const items = await adminPrisma.orderItem.findMany({ where: { order_id: order.id } });
    expect(items).toHaveLength(1);
    expect(items[0]!.quantity).toBe(2);
    expect(items[0]!.rate_class_id).toBeNull();
    expect(items[0]!.unit_price_cents).toBe(BASE_CENTS);
  });
});
