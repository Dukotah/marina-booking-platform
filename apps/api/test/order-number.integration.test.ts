/**
 * Order-number sequencing — live regression test against the seeded LSRA tenant.
 *
 * Guards a real bug: the per-service-day sequence must count orders that already share
 * the day's prefix, NOT orders *created* today. For a future slot, "created today" is ~0,
 * so the buggy version handed every booking sequence 1 and the second booking for any
 * given future service date collided on the unique `order_number`. This proves two
 * bookings on the SAME future service day now get distinct, sequential numbers.
 *
 * SKIPS without DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { orderNumberPrefix } from '@marina/core';
import { createBooking } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'ordernum-itest@example.com';

let activityId = '';
let rateId = '';
let locationCode = '';
let slot1 = '';
let slot2 = '';
let serviceDay: Date;
const createdOrderIds: string[] = [];

describe.skipIf(!HAS_DB)('order-number sequencing (live vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });

    const op = await adminPrisma.operator.findUnique({
      where: { id: OP },
      select: { location_code: true },
    });
    locationCode = op!.location_code;

    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true },
      },
      select: { id: true, activity_id: true },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed.');
    activityId = rate.activity_id;
    rateId = rate.id;

    // Two slots on the SAME far-future service day (distinct times) → same number prefix.
    const day = new Date(Date.now() + 50 * 24 * 60 * 60 * 1000);
    day.setUTCHours(18, 0, 0, 0);
    serviceDay = day;
    const db = forOperator(OP);
    for (const hourOffset of [0, 2]) {
      const s = await db.timeslot.create({
        data: {
          operator_id: OP,
          activity_id: activityId,
          datetime: new Date(day.getTime() + hourOffset * 60 * 60 * 1000),
          capacity_total: 10,
          capacity_booked: 0,
          status: 'AVAILABLE',
        },
        select: { id: true },
      });
      if (hourOffset === 0) slot1 = s.id;
      else slot2 = s.id;
    }
  });

  afterAll(async () => {
    if (createdOrderIds.length) {
      await adminPrisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    await adminPrisma.timeslot.deleteMany({ where: { id: { in: [slot1, slot2].filter(Boolean) } } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  it('assigns distinct, sequential numbers to two bookings on the same service day', async () => {
    const book = (timeslotId: string) =>
      createBooking(
        OP,
        {
          activityId,
          rateId,
          timeslotId,
          quantity: 1,
          customer: { first_name: 'OrderNum', last_name: 'Itest', email: TEST_EMAIL },
          participants: [],
        },
        { channel: 'STAFF' },
      );

    const o1 = await book(slot1);
    createdOrderIds.push(o1.id);
    const o2 = await book(slot2);
    createdOrderIds.push(o2.id);

    const prefix = orderNumberPrefix(locationCode, serviceDay);
    // Both belong to the same service day…
    expect(o1.order_number.startsWith(prefix)).toBe(true);
    expect(o2.order_number.startsWith(prefix)).toBe(true);
    // …and they are distinct (the bug produced an identical number → a unique-constraint 500).
    expect(o1.order_number).not.toBe(o2.order_number);
    // The second sequence is strictly greater than the first.
    const seq1 = Number(o1.order_number.slice(prefix.length));
    const seq2 = Number(o2.order_number.slice(prefix.length));
    expect(seq2).toBeGreaterThan(seq1);
  });
});
