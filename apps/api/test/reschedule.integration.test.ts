/**
 * Self-service reschedule — live integration test against the seeded LSRA tenant on
 * Neon. Reschedule is a key differentiator ("customers can reschedule online"), and
 * it moves capacity around, so we verify against real data that:
 *   - rescheduleBooking moves an item to another slot of the same activity: old slot
 *     capacity is released, the new slot takes it, the item repoints, an OrderEvent
 *     is logged;
 *   - a move to a full slot is refused (capacity unchanged);
 *   - the CUSTOMER channel enforces the activity's self-reschedule window (a booking
 *     whose current slot is imminent can't be self-rescheduled);
 *   - the HTTP self-service endpoint moves the booking when the email matches and
 *     404s when it doesn't (without leaking which order numbers exist).
 *
 * Skips without DATABASE_URL. Creates its own slots + bookings and deletes
 * everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { app } from '../src/app.js';
import { createBooking, rescheduleBooking, BookingError } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const EMAIL_MAIN = 'reschedule-itest@example.com';
const EMAIL_NEAR = 'reschedule-near-itest@example.com';
const DAY = 24 * 60 * 60 * 1000;

let activityId = '';
let rateId = '';
let qty = 1;
let maxCap = 10;
let slotA = '';
let slotB = '';
let slotFull = '';
let slotNear = '';
let mainOrderId = '';
let mainOrderNumber = '';
let nearOrderId = '';

async function makeSlot(offsetMs: number, capacityTotal: number, capacityBooked = 0): Promise<string> {
  const slot = await forOperator(OP).timeslot.create({
    data: {
      operator_id: OP,
      activity_id: activityId,
      datetime: new Date(Date.now() + offsetMs),
      capacity_total: capacityTotal,
      capacity_booked: capacityBooked,
      status: 'AVAILABLE',
    },
    select: { id: true },
  });
  return slot.id;
}

describe.skipIf(!HAS_DB)('reschedule (live vs Neon, LSRA seed)', () => {
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
    activityId = rate.activity_id;
    rateId = rate.id;
    qty = rate.activity.min_participants;
    maxCap = rate.activity.max_participants;

    await adminPrisma.customer.deleteMany({
      where: { operator_id: OP, email: { in: [EMAIL_MAIN, EMAIL_NEAR] } },
    });

    slotA = await makeSlot(30 * DAY, maxCap); // origin (far future)
    slotB = await makeSlot(31 * DAY, maxCap); // reschedule target
    slotFull = await makeSlot(32 * DAY, 1, 1); // full → capacity guard
    slotNear = await makeSlot(60 * 60 * 1000, maxCap); // ~1h out → inside the window

    const main = await createBooking(
      OP,
      {
        activityId,
        rateId,
        timeslotId: slotA,
        quantity: qty,
        customer: { first_name: 'Re', last_name: 'Schedule', email: EMAIL_MAIN },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    mainOrderId = main.id;
    mainOrderNumber = main.order_number;

    const near = await createBooking(
      OP,
      {
        activityId,
        rateId,
        timeslotId: slotNear,
        quantity: qty,
        customer: { first_name: 'Near', last_name: 'Soon', email: EMAIL_NEAR },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    nearOrderId = near.id;
  });

  afterAll(async () => {
    for (const id of [mainOrderId, nearOrderId]) {
      if (id) await adminPrisma.order.deleteMany({ where: { id } });
    }
    await adminPrisma.timeslot.deleteMany({
      where: { id: { in: [slotA, slotB, slotFull, slotNear].filter(Boolean) } },
    });
    await adminPrisma.customer.deleteMany({
      where: { operator_id: OP, email: { in: [EMAIL_MAIN, EMAIL_NEAR] } },
    });
    await adminPrisma.$disconnect();
  });

  it('moves the booking to a new slot: capacity follows, item repoints, event logged', async () => {
    await rescheduleBooking(OP, mainOrderId, slotB, { channel: 'STAFF', actor: 'itest' });

    const a = await adminPrisma.timeslot.findUnique({ where: { id: slotA } });
    const b = await adminPrisma.timeslot.findUnique({ where: { id: slotB } });
    expect(a!.capacity_booked).toBe(0); // released
    expect(b!.capacity_booked).toBe(qty); // taken

    const item = await adminPrisma.orderItem.findFirst({ where: { order_id: mainOrderId } });
    expect(item!.timeslot_id).toBe(slotB);

    const events = await adminPrisma.orderEvent.findMany({ where: { order_id: mainOrderId } });
    expect(events.some((e) => e.type === 'RESCHEDULED')).toBe(true);
  });

  it('refuses a move to a full slot and leaves capacity unchanged', async () => {
    await expect(
      rescheduleBooking(OP, mainOrderId, slotFull, { channel: 'STAFF' }),
    ).rejects.toThrow(BookingError);

    const b = await adminPrisma.timeslot.findUnique({ where: { id: slotB } });
    expect(b!.capacity_booked).toBe(qty); // still on slotB
    const item = await adminPrisma.orderItem.findFirst({ where: { order_id: mainOrderId } });
    expect(item!.timeslot_id).toBe(slotB);
  });

  it('enforces the self-reschedule window for the CUSTOMER channel', async () => {
    // nearOrder's current slot is ~1h out — inside the activity's window — so an
    // online reschedule must be refused.
    await expect(
      rescheduleBooking(OP, nearOrderId, slotA, { channel: 'CUSTOMER' }),
    ).rejects.toMatchObject({ code: 'RESCHEDULE_WINDOW_CLOSED' });
  });

  it('self-service HTTP endpoint moves the booking when the email matches', async () => {
    const res = await app.request(`/api/orders/${mainOrderNumber}/self-reschedule`, {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL_MAIN, timeslotId: slotA }),
    });
    expect(res.status).toBe(200);

    const item = await adminPrisma.orderItem.findFirst({ where: { order_id: mainOrderId } });
    expect(item!.timeslot_id).toBe(slotA); // moved back to A via HTTP
  });

  it('self-service HTTP endpoint 404s on a wrong email', async () => {
    const res = await app.request(`/api/orders/${mainOrderNumber}/self-reschedule`, {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-the-booker@example.com', timeslotId: slotB }),
    });
    expect(res.status).toBe(404);
  });
});
