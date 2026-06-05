/**
 * Availability service — live integration test against the seeded LSRA tenant on
 * Neon. Verifies the step of the funnel that precedes booking:
 *   - generateTimeslotsForRange creates evenly-spaced slots for a day (and is
 *     idempotent — a second run skips the already-populated day),
 *   - getDayAvailability rolls those slots up with the right capacity + status, and
 *   - booking into a slot is reflected in its capacity_booked / status the next time
 *     availability is read.
 *
 * Skips without DATABASE_URL. Generates slots only for a far-future day that the seed
 * never touches, and deletes them in afterAll, so it never disturbs real data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { createBooking } from '../src/services/booking.js';
import { generateTimeslotsForRange, getDayAvailability } from '../src/services/availability.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'availability-itest@example.com';

// A fixed far-future day (UTC) the seed never populates. Using a constant (not
// Date.now()) keeps the test deterministic and easy to clean up.
const DAY = '2030-07-15';
const DAY_START = new Date('2030-07-14T00:00:00.000Z');
const DAY_END = new Date('2030-07-16T00:00:00.000Z');

let activityId: string;
let rateId: string;
let minParticipants: number;
let createdOrderId: string | null = null;

describe.skipIf(!HAS_DB)('availability service (live vs Neon, LSRA seed)', () => {
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
        activity: { select: { min_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');
    activityId = rate.activity_id;
    rateId = rate.id;
    minParticipants = rate.activity.min_participants;

    // Clean any leftovers from a previous run (slots for the test day + test customer).
    await adminPrisma.timeslot.deleteMany({
      where: { operator_id: OP, activity_id: activityId, datetime: { gte: DAY_START, lt: DAY_END } },
    });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
  });

  afterAll(async () => {
    if (createdOrderId) await adminPrisma.order.deleteMany({ where: { id: createdOrderId } });
    await adminPrisma.timeslot.deleteMany({
      where: { operator_id: OP, activity_id: activityId, datetime: { gte: DAY_START, lt: DAY_END } },
    });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  it('generates evenly-spaced slots for a day and is idempotent', async () => {
    const db = forOperator(OP);
    // 9:00–12:00 hourly => 3 slots (09, 10, 11).
    const result = await generateTimeslotsForRange(db, {
      operatorId: OP,
      activityId,
      from: DAY,
      to: DAY,
      openHour: 9,
      closeHour: 12,
      intervalMinutes: 60,
      capacityTotal: 5,
    });
    expect(result.created).toBe(3);
    expect(result.daysGenerated).toBe(1);

    // Idempotent: re-running skips the now-populated day.
    const again = await generateTimeslotsForRange(db, {
      operatorId: OP,
      activityId,
      from: DAY,
      to: DAY,
      openHour: 9,
      closeHour: 12,
      intervalMinutes: 60,
      capacityTotal: 5,
    });
    expect(again.created).toBe(0);
    expect(again.daysSkipped).toBe(1);
  });

  it('rolls up the day as available capacity', async () => {
    const db = forOperator(OP);
    const day = await getDayAvailability(db, { activityId, date: DAY });
    expect(day.timeslots).toHaveLength(3);
    for (const slot of day.timeslots) {
      expect(slot.capacityTotal).toBe(5);
      expect(slot.capacityBooked).toBe(0);
      expect(slot.capacityRemaining).toBe(5);
      expect(slot.status).toBe('AVAILABLE');
    }
  });

  it('reflects a booking in the slot capacity the next time availability is read', async () => {
    const db = forOperator(OP);
    const before = await getDayAvailability(db, { activityId, date: DAY });
    const target = before.timeslots[0]!;

    const order = await createBooking(
      OP,
      {
        activityId,
        rateId,
        timeslotId: target.id,
        quantity: minParticipants,
        customer: { first_name: 'Avail', last_name: 'Tester', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'STAFF', actor: 'availability.integration.test' },
    );
    createdOrderId = order.id;

    const after = await getDayAvailability(db, { activityId, date: DAY });
    const updated = after.timeslots.find((s) => s.id === target.id)!;
    expect(updated.capacityBooked).toBe(minParticipants);
    expect(updated.capacityRemaining).toBe(5 - minParticipants);
  });
});
