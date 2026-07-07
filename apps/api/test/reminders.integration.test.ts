/**
 * Automated pre-arrival reminders — the no-show-reducing sweep. Proves, live against
 * the LSRA tenant and WITHOUT any email provider configured, that:
 *   - selection picks only UPCOMING bookings whose trip is inside the window,
 *   - the sweep is idempotent (an order is reminded at most once), and
 *   - a cancelled booking in the window is never reminded.
 *
 * The email send is a no-op without RESEND_API_KEY, so this asserts the ENGINE
 * (selection + dedup + audit), which is the automation that was missing. SKIPS
 * without DATABASE_URL so plain `pnpm test` stays green.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { createBooking, cancelBooking } from '../src/services/booking.js';
import {
  selectDueReminderOrderIds,
  runDueReminders,
  REMINDER_EVENT_TYPE,
} from '../src/services/notifications.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'reminder-itest@example.com';

interface Fx {
  activityId: string;
  rateId: string;
  nearSlotId: string; // starts in ~2h (inside a 24h window)
  farSlotId: string; // starts in ~72h (outside)
}
let fx: Fx;
const orderIds: string[] = [];

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
      customer: { first_name: 'Rem', last_name: 'Itest', email: TEST_EMAIL },
      participants: [],
    },
    { channel: 'CUSTOMER', actor: 'reminders.integration.test' },
  );
}

describe.skipIf(!HAS_DB)('automated reminders (live vs LSRA)', () => {
  beforeAll(async () => {
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });

    const activity = await adminPrisma.activity.create({
      data: {
        operator_id: OP,
        name_internal: 'ITEST Reminder Activity',
        name_external: 'ITEST Reminder Activity',
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
      nearSlotId: await makeSlot(activity.id, new Date(Date.now() + 2 * 60 * 60 * 1000)),
      farSlotId: await makeSlot(activity.id, new Date(Date.now() + 72 * 60 * 60 * 1000)),
    };
  });

  afterAll(async () => {
    for (const id of orderIds) await adminPrisma.order.deleteMany({ where: { id } });
    if (fx) {
      await adminPrisma.timeslot.deleteMany({ where: { id: { in: [fx.nearSlotId, fx.farSlotId] } } });
      await adminPrisma.rate.deleteMany({ where: { id: fx.rateId } });
      await adminPrisma.activity.deleteMany({ where: { id: fx.activityId } });
    }
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  it('selects only bookings whose trip is inside the window', async () => {
    const near = await book(fx.nearSlotId);
    const far = await book(fx.farSlotId);
    orderIds.push(near.id, far.id);

    const db = forOperator(OP);
    const now = new Date();
    const within24 = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const due = await selectDueReminderOrderIds(db, now, within24);

    expect(due).toContain(near.id);
    expect(due).not.toContain(far.id);
  });

  it('runs the sweep and is idempotent (reminds each order at most once)', async () => {
    const first = await runDueReminders(OP, { withinHours: 24 });
    // The near order is due; without a Resend key it is processed as a no-op.
    expect(first.due).toBeGreaterThanOrEqual(1);
    expect(first.noop).toBeGreaterThanOrEqual(1);

    // A REMINDER_SENT audit event now exists on the near order.
    const events = await adminPrisma.orderEvent.findMany({
      where: { order_id: orderIds[0], type: REMINDER_EVENT_TYPE },
    });
    expect(events.length).toBe(1);

    // Second run: the near order is already stamped, so it is not re-processed.
    const second = await runDueReminders(OP, { withinHours: 24 });
    const stillOne = await adminPrisma.orderEvent.count({
      where: { order_id: orderIds[0], type: REMINDER_EVENT_TYPE },
    });
    expect(stillOne).toBe(1);
    // Our near order shouldn't be re-counted (second sweep may still pick up other
    // unrelated seed orders in the window, so assert on OUR order's event count).
    expect(second.due).toBeLessThan(first.due + 1);
  });

  it('never reminds a cancelled booking in the window', async () => {
    // Fresh near-window order, then cancel it before the sweep.
    const doomed = await book(fx.nearSlotId);
    orderIds.push(doomed.id);
    await cancelBooking(OP, doomed.id, { actor: 'reminders.integration.test' });

    const db = forOperator(OP);
    const now = new Date();
    const due = await selectDueReminderOrderIds(db, now, new Date(now.getTime() + 24 * 60 * 60 * 1000));
    expect(due).not.toContain(doomed.id);
  });
});
