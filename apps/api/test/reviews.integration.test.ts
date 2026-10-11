/**
 * Automated post-trip review requests — the reputation-building sweep. Proves,
 * live against the LSRA tenant and WITHOUT any email provider configured, that:
 *   - selection picks only non-cancelled bookings whose trip ENDED before the
 *     cutoff (now - afterHours), never a trip that is still upcoming/running,
 *   - the sweep is idempotent (an order is asked for a review at most once), and
 *   - a cancelled booking whose trip ended is never asked.
 *
 * Asserts the ENGINE (selection + dedup + audit), mirroring reminders.integration.
 * The operator's review_url is set for the duration of the test so the email path
 * is exercised, then restored. Under the local sandbox the send is captured rather
 * than posted to a provider, so delivery counts are real. SKIPS without
 * DATABASE_URL so plain `pnpm test` stays green.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { createBooking, cancelBooking } from '../src/services/booking.js';
import {
  selectDuePostTripOrderIds,
  runDuePostTripReviews,
  REVIEW_EVENT_TYPE,
} from '../src/services/notifications.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'review-itest@example.com';

interface Fx {
  activityId: string;
  rateId: string;
  endedSlotId: string; // booked while future, then shifted to start 4h ago (60-min trip => ended ~3h ago)
  futureSlotId: string; // starts in ~4h (not ended)
}
let fx: Fx;
let priorReviewUrl: string | null = null;
const orderIds: string[] = [];
const extraSlotIds: string[] = [];

async function makeSlot(activityId: string, at: Date): Promise<string> {
  const s = await adminPrisma.timeslot.create({
    data: { operator_id: OP, activity_id: activityId, datetime: at, capacity_total: 10, capacity_booked: 0, status: 'AVAILABLE' },
    select: { id: true },
  });
  return s.id;
}

function book(timeslotId: string) {
  return createBooking(
    OP,
    {
      activityId: fx.activityId,
      rateId: fx.rateId,
      timeslotId,
      quantity: 1,
      customer: { first_name: 'Rev', last_name: 'Itest', email: TEST_EMAIL },
      participants: [],
    },
    { channel: 'CUSTOMER', actor: 'reviews.integration.test' },
  );
}

describe.skipIf(!HAS_DB)('automated post-trip reviews (live vs LSRA)', () => {
  beforeAll(async () => {
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });

    // Ensure the operator has a review_url so the email path is live; restore after.
    const op = await adminPrisma.operator.findUniqueOrThrow({
      where: { id: OP },
      select: { review_url: true },
    });
    priorReviewUrl = op.review_url;
    await adminPrisma.operator.update({
      where: { id: OP },
      data: { review_url: 'https://g.page/r/review-itest' },
    });

    const activity = await adminPrisma.activity.create({
      data: {
        operator_id: OP,
        name_internal: 'ITEST Review Activity',
        name_external: 'ITEST Review Activity',
        status: 'ACTIVE',
        min_participants: 1,
        max_participants: 10,
      },
      select: { id: true },
    });
    const rate = await adminPrisma.rate.create({
      data: { operator_id: OP, activity_id: activity.id, name_internal: 'Hr', name_external: 'Hr', price_cents: 5000, duration_minutes: 60, is_active: true },
      select: { id: true },
    });

    fx = {
      activityId: activity.id,
      rateId: rate.id,
      // Created in the future so CUSTOMER bookings are allowed; shifted to the past
      // (below) once the orders exist, so the trips read as "ended".
      endedSlotId: await makeSlot(activity.id, new Date(Date.now() + 4 * 60 * 60 * 1000)),
      futureSlotId: await makeSlot(activity.id, new Date(Date.now() + 4 * 60 * 60 * 1000)),
    };
  });

  /** Move a slot into the past so its 60-minute trip has already ended. */
  async function shiftToPast(slotId: string): Promise<void> {
    await adminPrisma.timeslot.update({
      where: { id: slotId },
      data: { datetime: new Date(Date.now() - 4 * 60 * 60 * 1000) },
    });
  }

  afterAll(async () => {
    for (const id of orderIds) await adminPrisma.order.deleteMany({ where: { id } });
    if (fx) {
      await adminPrisma.timeslot.deleteMany({ where: { id: { in: [fx.endedSlotId, fx.futureSlotId, ...extraSlotIds] } } });
      await adminPrisma.rate.deleteMany({ where: { id: fx.rateId } });
      await adminPrisma.activity.deleteMany({ where: { id: fx.activityId } });
    }
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.operator.update({ where: { id: OP }, data: { review_url: priorReviewUrl } });
    await adminPrisma.$disconnect();
  });

  it('selects only bookings whose trip ENDED before the cutoff', async () => {
    const ended = await book(fx.endedSlotId);
    const future = await book(fx.futureSlotId);
    orderIds.push(ended.id, future.id);
    // Now that the booking exists, slide its slot into the past so the trip ended.
    await shiftToPast(fx.endedSlotId);

    const db = forOperator(OP);
    // Cutoff = now - 2h. The ended trip finished ~3h ago (in), the future one has
    // not even started (out).
    const endedBefore = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const due = await selectDuePostTripOrderIds(db, endedBefore);

    expect(due).toContain(ended.id);
    expect(due).not.toContain(future.id);
  });

  it('runs the sweep and is idempotent (asks each order at most once)', async () => {
    const first = await runDuePostTripReviews(OP, { afterHours: 2 });
    expect(first.due).toBeGreaterThanOrEqual(1);
    expect(first.delivered + first.noop).toBe(first.due);
    // review_url is set + sandbox captures the send, so our ended order delivers.
    expect(first.delivered).toBeGreaterThanOrEqual(1);

    const events = await adminPrisma.orderEvent.findMany({
      where: { order_id: orderIds[0], type: REVIEW_EVENT_TYPE },
    });
    expect(events.length).toBe(1);

    // Second run: the ended order is already stamped, so it is not re-processed.
    await runDuePostTripReviews(OP, { afterHours: 2 });
    const stillOne = await adminPrisma.orderEvent.count({
      where: { order_id: orderIds[0], type: REVIEW_EVENT_TYPE },
    });
    expect(stillOne).toBe(1);
  });

  it('never asks a cancelled booking whose trip ended', async () => {
    // Fresh future slot so the CUSTOMER booking is allowed, then cancel it and
    // slide the slot into the past so its trip has "ended".
    const slotId = await makeSlot(fx.activityId, new Date(Date.now() + 4 * 60 * 60 * 1000));
    const doomed = await book(slotId);
    orderIds.push(doomed.id);
    await cancelBooking(OP, doomed.id, { actor: 'reviews.integration.test' });
    await shiftToPast(slotId);

    const db = forOperator(OP);
    const endedBefore = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const due = await selectDuePostTripOrderIds(db, endedBefore);
    expect(due).not.toContain(doomed.id);
    extraSlotIds.push(slotId);
  });
});
