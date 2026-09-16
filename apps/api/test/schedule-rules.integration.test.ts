/**
 * ScheduleRule materialization — live integration tests against the seeded LSRA
 * tenant. This is the FareHarbor-style repeating-schedule engine
 * (packages/database/src/schedule.ts): rules generate timeslots over a rolling
 * horizon, idempotently, under the calendar-safety invariants:
 *
 *   - re-running materialization creates no duplicates,
 *   - multiple rules compose (union of departures; highest capacity wins a tie),
 *   - blackout days win over rules (activity-scoped AND operator-wide),
 *   - booked slots are never deleted or shrunk below their booked count,
 *   - one-off (hand-created) slots are never touched by rules,
 *   - manually closed times stay closed,
 *   - removing a rule withdraws only its FUTURE UNBOOKED slots,
 *   - RLS keeps one operator's rules invisible to another.
 *
 * Uses a dedicated, online-hidden activity so the seed calendar is never
 * disturbed; everything is deleted in afterAll. Skips without DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  adminPrisma,
  forOperator,
  withTenant,
  materializeActivitySchedule,
  removeScheduleRule,
  ScheduleRuleError,
} from '@marina/database';
import { createBooking } from '../src/services/booking.js';
import { getDayAvailability } from '../src/services/availability.js';
import { runScheduleSweep } from '../src/services/schedules.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const OTHER_OP = 'sched-itest-op';
const TEST_EMAIL = 'schedule-rules-itest@example.com';
const ACTIVITY_NAME = 'Schedule Rules ITest Boat';

// ---------------------------------------------------------------------------
// Calendar helpers (pure, UTC-based — mirror the engine's ISO-day arithmetic)
// ---------------------------------------------------------------------------

function addIsoDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function isoWeekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function todayIsoIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** The next day with the given weekday that is at least `minDaysOut` ahead. */
function nextWeekday(fromIso: string, weekday: number, minDaysOut: number): string {
  let iso = addIsoDays(fromIso, minDaysOut);
  while (isoWeekday(iso) !== weekday) iso = addIsoDays(iso, 1);
  return iso;
}

let activityId: string;
let rateId: string;
let timeZone: string;
let today: string;
/** A Monday 5–11 days out — far enough that every departure is in the future. */
let monday: string;
let createdOrderIds: string[] = [];

const WEEKDAY_RULE = {
  name: 'Weekday mornings',
  weekdays: [1, 2, 3, 4, 5],
  start_minutes: [480, 600, 840], // 8:00, 10:00, 2:00
};

describe.skipIf(!HAS_DB)('schedule rules (live materialization, LSRA seed)', () => {
  beforeAll(async () => {
    // Clean any leftovers from a previous run.
    const leftover = await adminPrisma.activity.findFirst({
      where: { operator_id: OP, name_internal: ACTIVITY_NAME },
      select: { id: true },
    });
    if (leftover) {
      await adminPrisma.orderItem.deleteMany({ where: { activity_id: leftover.id } });
      await adminPrisma.timeslot.updateMany({
        where: { activity_id: leftover.id },
        data: { schedule_rule_id: null },
      });
      await adminPrisma.activity.delete({ where: { id: leftover.id } });
    }
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.operator.deleteMany({ where: { id: OTHER_OP } });

    const op = await adminPrisma.operator.findUniqueOrThrow({
      where: { id: OP },
      select: { timezone: true },
    });
    timeZone = op.timezone;
    today = todayIsoIn(timeZone);
    monday = nextWeekday(today, 1, 5);

    const activity = await adminPrisma.activity.create({
      data: {
        operator_id: OP,
        name_internal: ACTIVITY_NAME,
        name_external: ACTIVITY_NAME,
        category: 'BOAT',
        status: 'ACTIVE',
        visible_online: false, // keep the live demo catalog clean
        max_participants: 8,
      },
    });
    activityId = activity.id;
    const rate = await adminPrisma.rate.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        name_internal: 'ITest rate',
        name_external: 'ITest rate',
        price_cents: 10_000,
        duration_minutes: 120,
      },
    });
    rateId = rate.id;
  });

  afterAll(async () => {
    for (const orderId of createdOrderIds) {
      await adminPrisma.order.deleteMany({ where: { id: orderId } });
    }
    // GUARD: if beforeAll failed, activityId is undefined — and Prisma treats
    // `where: { id: undefined }` as NO filter, which would delete EVERYTHING.
    // Never run the scoped cleanup without a concrete id.
    if (activityId) {
      await adminPrisma.orderItem.deleteMany({ where: { activity_id: activityId } });
      // Rules, blackouts and timeslots cascade off the activity... except timeslots
      // referencing a rule (NO ACTION); clear those references first.
      await adminPrisma.timeslot.updateMany({
        where: { activity_id: activityId },
        data: { schedule_rule_id: null },
      });
      await adminPrisma.activity.deleteMany({ where: { id: activityId } });
    }
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.operator.deleteMany({ where: { id: OTHER_OP } });
    await adminPrisma.$disconnect();
  });

  it('materializes a rule over the horizon and is idempotent on re-run', async () => {
    const result = await withTenant(OP, async (tx) => {
      await tx.scheduleRule.create({
        data: {
          operator_id: OP,
          activity_id: activityId,
          ...WEEKDAY_RULE,
          start_date: today,
          end_date: addIsoDays(today, 365),
          capacity: null, // follow activity.max_participants (8)
        },
      });
      return materializeActivitySchedule(tx, { operatorId: OP, activityId });
    });

    expect(result.created).toBeGreaterThan(0);
    expect(result.removed).toBe(0);

    // Next Monday got exactly the three departures, at capacity 8, rule-owned.
    const slots = await slotsOn(monday);
    expect(slots.map((s) => s.minutes)).toEqual([480, 600, 840]);
    for (const s of slots) {
      expect(s.capacity_total).toBe(8);
      expect(s.schedule_rule_id).not.toBeNull();
      expect(s.status).toBe('AVAILABLE');
    }

    // Idempotent: a second run has nothing to do.
    const again = await withTenant(OP, (tx) =>
      materializeActivitySchedule(tx, { operatorId: OP, activityId }),
    );
    expect(again.created).toBe(0);
    expect(again.resized).toBe(0);
    expect(again.removed).toBe(0);
    expect(again.plan.noChange).toBe(true);
  });

  it('composes multiple rules: union of departures, highest capacity wins a shared instant', async () => {
    const saturday = nextWeekday(today, 6, 5);
    const overlapping = await withTenant(OP, async (tx) => {
      await tx.scheduleRule.create({
        data: {
          operator_id: OP,
          activity_id: activityId,
          name: 'Weekend cruise',
          weekdays: [0, 6],
          start_minutes: [540], // 9:00
          start_date: today,
          end_date: addIsoDays(today, 365),
          capacity: 12,
        },
      });
      // Third rule lands on the SAME Monday 8:00 instant with a bigger boat.
      return tx.scheduleRule.create({
        data: {
          operator_id: OP,
          activity_id: activityId,
          name: 'Overlap test',
          weekdays: [1],
          start_minutes: [480],
          start_date: today,
          end_date: addIsoDays(today, 365),
          capacity: 20,
        },
      });
    });
    await withTenant(OP, (tx) =>
      materializeActivitySchedule(tx, { operatorId: OP, activityId }),
    );

    const saturdaySlots = await slotsOn(saturday);
    expect(saturdaySlots.map((s) => s.minutes)).toEqual([540]);
    expect(saturdaySlots[0]!.capacity_total).toBe(12);

    // Monday 8:00 is wanted by two rules — one slot, the generous capacity.
    const mondaySlots = await slotsOn(monday);
    expect(mondaySlots.map((s) => s.minutes)).toEqual([480, 600, 840]);
    expect(mondaySlots.find((s) => s.minutes === 480)!.capacity_total).toBe(20);

    // Dropping the overlap rule returns the instant to the weekday rule's capacity.
    await withTenant(OP, (tx) =>
      removeScheduleRule(tx, { operatorId: OP, ruleId: overlapping.id }),
    );
    const after = await slotsOn(monday);
    expect(after.map((s) => s.minutes)).toEqual([480, 600, 840]);
    expect(after.find((s) => s.minutes === 480)!.capacity_total).toBe(8);
  });

  it('blackouts win: activity-scoped and operator-wide days generate nothing and withdraw unbooked slots', async () => {
    const blackoutMonday = nextWeekday(today, 1, 12);
    const blackoutTuesday = addIsoDays(blackoutMonday, 1);

    expect((await slotsOn(blackoutMonday)).length).toBe(3);

    const [activityScoped, operatorWide] = await withTenant(OP, async (tx) => {
      const a = await tx.blackoutDate.create({
        data: {
          operator_id: OP,
          activity_id: activityId,
          date: new Date(`${blackoutMonday}T00:00:00.000Z`),
          reason: 'Engine service',
        },
      });
      const b = await tx.blackoutDate.create({
        data: {
          operator_id: OP,
          date: new Date(`${blackoutTuesday}T00:00:00.000Z`),
          reason: 'Marina closed',
        },
      });
      await materializeActivitySchedule(tx, { operatorId: OP, activityId });
      return [a, b];
    });

    expect((await slotsOn(blackoutMonday)).length).toBe(0);
    expect((await slotsOn(blackoutTuesday)).length).toBe(0);

    // The customer-facing read agrees (activity-scoped blackout hides the day).
    const db = forOperator(OP);
    const day = await getDayAvailability(db, { activityId, date: blackoutMonday });
    expect(day.timeslots).toHaveLength(0);

    // Lifting the blackouts brings the departures back on the next run.
    await withTenant(OP, async (tx) => {
      await tx.blackoutDate.deleteMany({
        where: { id: { in: [activityScoped.id, operatorWide.id] } },
      });
      await materializeActivitySchedule(tx, { operatorId: OP, activityId });
    });
    expect((await slotsOn(blackoutMonday)).length).toBe(3);
    expect((await slotsOn(blackoutTuesday)).length).toBe(3);
  });

  it('never deletes a booked slot and never shrinks capacity below the booked count', async () => {
    const slots = await slotsOn(monday);
    const target = slots.find((s) => s.minutes === 480)!;

    const order = await createBooking(
      OP,
      {
        activityId,
        rateId,
        timeslotId: target.id,
        quantity: 2,
        customer: { first_name: 'Sched', last_name: 'Tester', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'STAFF', actor: 'schedule-rules.integration.test' },
    );
    createdOrderIds.push(order.id);

    // Shrink the rule's capacity to 1 — below the 2 seats already booked.
    await withTenant(OP, async (tx) => {
      await tx.scheduleRule.updateMany({
        where: { activity_id: activityId, name: WEEKDAY_RULE.name },
        data: { capacity: 1 },
      });
      await materializeActivitySchedule(tx, { operatorId: OP, activityId });
    });

    const after = await slotsOn(monday);
    const booked = after.find((s) => s.id === target.id)!;
    expect(booked.capacity_total).toBe(2); // max(rule capacity 1, booked 2)
    expect(after.find((s) => s.minutes === 600)!.capacity_total).toBe(1);

    // Now remove 8:00 from the rule entirely: unbooked 8:00s vanish, the booked
    // one survives untouched.
    await withTenant(OP, async (tx) => {
      await tx.scheduleRule.updateMany({
        where: { activity_id: activityId, name: WEEKDAY_RULE.name },
        data: { start_minutes: [600, 840], capacity: null },
      });
      await materializeActivitySchedule(tx, { operatorId: OP, activityId });
    });

    const nextMonday = addIsoDays(monday, 7);
    expect((await slotsOn(nextMonday)).map((s) => s.minutes)).toEqual([600, 840]);
    const survivor = await adminPrisma.timeslot.findUnique({ where: { id: target.id } });
    expect(survivor).not.toBeNull();
    expect(survivor!.capacity_booked).toBe(2);
    expect(survivor!.status).not.toBe('CANCELLED');
  });

  it('leaves one-off hand-created slots alone', async () => {
    // A one-off at an instant no rule produces...
    const oneOffAt = await withTenant(OP, async (tx) => {
      const wednesday = nextWeekday(today, 3, 5);
      const slot = await tx.timeslot.create({
        data: {
          operator_id: OP,
          activity_id: activityId,
          // 6:33 AM local is nothing any rule generates. Stored as if UTC-offset
          // does not matter for the assertion — we only check survival by id.
          datetime: new Date(`${wednesday}T13:33:00.000Z`),
          capacity_total: 3,
          status: 'AVAILABLE',
        },
      });
      await materializeActivitySchedule(tx, { operatorId: OP, activityId });
      return slot;
    });

    const still = await adminPrisma.timeslot.findUnique({ where: { id: oneOffAt.id } });
    expect(still).not.toBeNull();
    expect(still!.capacity_total).toBe(3);
    expect(still!.schedule_rule_id).toBeNull();
  });

  it('keeps manually closed times closed across re-materialization', async () => {
    const friday = nextWeekday(today, 5, 5);
    const slots = await slotsOn(friday);
    const target = slots.find((s) => s.minutes === 600)!;

    await withTenant(OP, async (tx) => {
      await tx.timeslot.update({ where: { id: target.id }, data: { status: 'CANCELLED' } });
      await materializeActivitySchedule(tx, { operatorId: OP, activityId });
    });

    const after = await adminPrisma.timeslot.findMany({
      where: { activity_id: activityId, datetime: target.datetime },
    });
    expect(after).toHaveLength(1); // no duplicate created next to the closed one
    expect(after[0]!.status).toBe('CANCELLED');
  });

  it('removing a rule withdraws only its future unbooked slots', async () => {
    const rule = await adminPrisma.scheduleRule.findFirstOrThrow({
      where: { activity_id: activityId, name: WEEKDAY_RULE.name },
    });
    const before = await adminPrisma.timeslot.count({
      where: { activity_id: activityId, schedule_rule_id: rule.id },
    });
    expect(before).toBeGreaterThan(0);

    await withTenant(OP, (tx) => removeScheduleRule(tx, { operatorId: OP, ruleId: rule.id }));

    // The weekday departures are gone...
    const nextMonday = addIsoDays(monday, 7);
    expect((await slotsOn(nextMonday)).length).toBe(0);
    // ...but the weekend rule's slots are untouched,
    const saturday = nextWeekday(today, 6, 5);
    expect((await slotsOn(saturday)).length).toBe(1);
    // ...and the booked Monday 8:00 survives as a detached one-off.
    const survivors = await adminPrisma.timeslot.findMany({
      where: { activity_id: activityId, capacity_booked: { gt: 0 } },
    });
    expect(survivors.length).toBeGreaterThan(0);
    for (const s of survivors) expect(s.schedule_rule_id).toBeNull();
  });

  it('the rolling sweep tops the horizon back up idempotently', async () => {
    // Simulate days rolling forward by deleting a future unbooked weekend slot.
    const saturday = nextWeekday(today, 6, 12);
    const removed = await adminPrisma.timeslot.deleteMany({
      where: {
        activity_id: activityId,
        datetime: {
          gte: new Date(`${saturday}T00:00:00.000Z`),
          lt: new Date(`${addIsoDays(saturday, 1)}T23:59:59.000Z`),
        },
        capacity_booked: 0,
      },
    });
    expect(removed.count).toBeGreaterThan(0);

    const sweep = await runScheduleSweep();
    expect(sweep.activities).toBeGreaterThan(0);
    expect(sweep.created).toBeGreaterThanOrEqual(removed.count);
    expect((await slotsOn(saturday)).length).toBe(1);

    const again = await runScheduleSweep();
    expect(again.created).toBe(0);
    expect(again.removed).toBe(0);
  });

  it('RLS isolates rules and materialization between operators', async () => {
    await adminPrisma.operator.create({
      data: {
        id: OTHER_OP,
        slug: OTHER_OP,
        name_internal: 'Schedule ITest Op',
        name_external: 'Schedule ITest Op',
        location_code: 'SCHED-ITEST',
      },
    });

    // The other tenant sees none of LSRA's rules...
    const foreign = forOperator(OTHER_OP);
    expect(await foreign.scheduleRule.findMany()).toHaveLength(0);

    // ...and cannot materialize (or even see) LSRA's activity.
    await expect(
      withTenant(OTHER_OP, (tx) =>
        materializeActivitySchedule(tx, { operatorId: OTHER_OP, activityId }),
      ),
    ).rejects.toThrow(ScheduleRuleError);
  });
});

// ---------------------------------------------------------------------------

interface SlotFact {
  id: string;
  minutes: number;
  capacity_total: number;
  capacity_booked: number;
  status: string;
  schedule_rule_id: string | null;
  datetime: Date;
}

/** Non-cancelled slots on a local calendar day, sorted by local start time. */
async function slotsOn(dayIso: string): Promise<SlotFact[]> {
  // Generous UTC window around the local day, filtered by rendered local day.
  const start = new Date(`${dayIso}T00:00:00.000Z`);
  const rows = await adminPrisma.timeslot.findMany({
    where: {
      activity_id: activityId,
      status: { not: 'CANCELLED' },
      datetime: {
        gte: new Date(start.getTime() - 86_400_000),
        lt: new Date(start.getTime() + 2 * 86_400_000),
      },
    },
    orderBy: { datetime: 'asc' },
  });
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const out: SlotFact[] = [];
  for (const r of rows) {
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(r.datetime)) {
      if (p.type !== 'literal') parts[p.type] = p.value;
    }
    const iso = `${parts.year}-${parts.month}-${parts.day}`;
    if (iso !== dayIso) continue;
    let hour = parseInt(parts.hour ?? '0', 10);
    if (hour === 24) hour = 0;
    out.push({
      id: r.id,
      minutes: hour * 60 + parseInt(parts.minute ?? '0', 10),
      capacity_total: r.capacity_total,
      capacity_booked: r.capacity_booked,
      status: r.status,
      schedule_rule_id: r.schedule_rule_id,
      datetime: r.datetime,
    });
  }
  return out;
}
