/**
 * Reminder job — live integration test against the seeded LSRA tenant on Neon. The
 * pre-arrival reminder sweep selects upcoming bookings inside a look-ahead window
 * and sends each exactly once. We verify against real data that:
 *   - sendDueReminders stamps `reminder_sent_at` on an in-window UPCOMING booking
 *     (with a real email) and leaves a far-future booking and a CANCELLED booking
 *     untouched;
 *   - it is idempotent — a re-run does not re-select an already-stamped booking;
 *   - the HTTP trigger (POST /jobs/reminders) is open in dev (no secret) and
 *     enforces the shared `JOBS_SECRET` when one is configured (401 without it).
 *
 * The seed's RESEND_API_KEY 403s (unverified domain), so the real send fails at the
 * provider — which still counts as "dispatched" and stamps the booking (best-effort
 * delivery, no retry-storm). We assert the *stamping/selection* behaviour, which is
 * independent of whether the provider actually delivered.
 *
 * Skips without DATABASE_URL. Creates its own slots + bookings and deletes
 * everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { app } from '../src/app.js';
import { createBooking } from '../src/services/booking.js';
import { sendDueReminders } from '../src/services/reminders.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const EMAIL_DUE = 'reminder-due-itest@example.com';
const EMAIL_FAR = 'reminder-far-itest@example.com';
const EMAIL_CANCELLED = 'reminder-cancelled-itest@example.com';

let activityId = '';
let rateId = '';
let qty = 1;
let maxCap = 10;
let slotDue = '';
let slotFar = '';
let slotCancelled = '';
let dueOrderId = '';
let farOrderId = '';
let cancelledOrderId = '';

async function makeSlot(offsetMs: number): Promise<string> {
  const slot = await forOperator(OP).timeslot.create({
    data: {
      operator_id: OP,
      activity_id: activityId,
      datetime: new Date(Date.now() + offsetMs),
      capacity_total: maxCap,
      capacity_booked: 0,
      status: 'AVAILABLE',
    },
    select: { id: true },
  });
  return slot.id;
}

async function reminderStamp(orderId: string): Promise<Date | null> {
  const o = await adminPrisma.order.findUnique({
    where: { id: orderId },
    select: { reminder_sent_at: true },
  });
  return o?.reminder_sent_at ?? null;
}

describe.skipIf(!HAS_DB)('reminder job (live vs Neon, LSRA seed)', () => {
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
      where: { operator_id: OP, email: { in: [EMAIL_DUE, EMAIL_FAR, EMAIL_CANCELLED] } },
    });

    slotDue = await makeSlot(2 * HOUR); // inside a 24h window
    slotFar = await makeSlot(30 * DAY); // well outside the window
    slotCancelled = await makeSlot(3 * HOUR); // in-window but the order is cancelled

    const due = await createBooking(
      OP,
      { activityId, rateId, timeslotId: slotDue, quantity: qty, customer: { first_name: 'Due', last_name: 'Soon', email: EMAIL_DUE }, participants: [] },
      { channel: 'CUSTOMER' },
    );
    dueOrderId = due.id;

    const far = await createBooking(
      OP,
      { activityId, rateId, timeslotId: slotFar, quantity: qty, customer: { first_name: 'Far', last_name: 'Out', email: EMAIL_FAR }, participants: [] },
      { channel: 'CUSTOMER' },
    );
    farOrderId = far.id;

    const cancelled = await createBooking(
      OP,
      { activityId, rateId, timeslotId: slotCancelled, quantity: qty, customer: { first_name: 'Cxl', last_name: 'Booking', email: EMAIL_CANCELLED }, participants: [] },
      { channel: 'CUSTOMER' },
    );
    cancelledOrderId = cancelled.id;
    await adminPrisma.order.update({ where: { id: cancelledOrderId }, data: { status: 'CANCELLED' } });
  });

  afterAll(async () => {
    for (const id of [dueOrderId, farOrderId, cancelledOrderId]) {
      if (id) await adminPrisma.order.deleteMany({ where: { id } });
    }
    await adminPrisma.timeslot.deleteMany({
      where: { id: { in: [slotDue, slotFar, slotCancelled].filter(Boolean) } },
    });
    await adminPrisma.customer.deleteMany({
      where: { operator_id: OP, email: { in: [EMAIL_DUE, EMAIL_FAR, EMAIL_CANCELLED] } },
    });
    await adminPrisma.$disconnect();
  });

  it('stamps the in-window booking and leaves far-future + cancelled bookings untouched', async () => {
    expect(await reminderStamp(dueOrderId)).toBeNull(); // not yet reminded

    const summary = await sendDueReminders({ leadHours: 24, operatorId: OP });
    expect(summary.emailConfigured).toBe(true);
    expect(summary.considered).toBeGreaterThanOrEqual(1);
    // The 403 key means the provider attempt is recorded as a failure, but it is
    // still dispatched and therefore stamped (best-effort). Either way at least one
    // booking was acted on.
    expect(summary.sent + summary.failed).toBeGreaterThanOrEqual(1);

    expect(await reminderStamp(dueOrderId)).not.toBeNull(); // reminded
    expect(await reminderStamp(farOrderId)).toBeNull(); // outside the window
    expect(await reminderStamp(cancelledOrderId)).toBeNull(); // not UPCOMING
  });

  it('is idempotent — a re-run does not re-stamp an already-reminded booking', async () => {
    const firstStamp = await reminderStamp(dueOrderId);
    expect(firstStamp).not.toBeNull();

    await sendDueReminders({ leadHours: 24, operatorId: OP });

    const secondStamp = await reminderStamp(dueOrderId);
    expect(secondStamp!.getTime()).toBe(firstStamp!.getTime()); // unchanged → not re-selected
  });

  it('HTTP trigger is open in dev without a JOBS_SECRET (empty window → no side effects)', async () => {
    expect(process.env.JOBS_SECRET).toBeUndefined();
    // A tiny look-ahead window selects nothing, so this asserts auth/shape only.
    const res = await app.request('/jobs/reminders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leadHours: 0.001, operatorId: OP }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; summary: { considered: number } };
    expect(body.ok).toBe(true);
    expect(body.summary.considered).toBe(0);
  });

  it('HTTP trigger enforces JOBS_SECRET when one is configured', async () => {
    process.env.JOBS_SECRET = 'test-secret-123';
    try {
      const noAuth = await app.request('/jobs/reminders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leadHours: 0.001, operatorId: OP }),
      });
      expect(noAuth.status).toBe(401);

      const wrong = await app.request('/jobs/reminders', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jobs-secret': 'nope' },
        body: JSON.stringify({ leadHours: 0.001, operatorId: OP }),
      });
      expect(wrong.status).toBe(401);

      const ok = await app.request('/jobs/reminders', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret-123' },
        body: JSON.stringify({ leadHours: 0.001, operatorId: OP }),
      });
      expect(ok.status).toBe(200);
    } finally {
      delete process.env.JOBS_SECRET;
    }
  });
});
