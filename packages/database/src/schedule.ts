import type { Prisma } from '@prisma/client';

/**
 * Repeating-schedule materialization — the engine behind FareHarbor-style
 * per-activity schedules ("Summer weekdays: Mon–Fri at 8:00, 10:00, 2:00").
 *
 * A ScheduleRule is a recipe; Timeslot rows stay the single source of truth the
 * booking engine reads. This module turns the recipes into rows over a rolling
 * horizon, idempotently, under invariants that keep an operator's calendar safe:
 *
 *  1. A slot somebody has booked is NEVER deleted, closed, or shrunk below its
 *     booked count by a rule change. It survives the rule that made it.
 *  2. One-off slots (schedule_rule_id null — seeded, wizard-made, or hand-created)
 *     are never touched: rules only manage the slots they generated.
 *  3. A slot the operator closed by hand (status CANCELLED) stays closed — a rule
 *     re-materializing over it never quietly re-opens it or duplicates it.
 *  4. Blackout days win: rules generate nothing there, and future UNBOOKED
 *     rule-generated slots on a newly blacked-out day are withdrawn.
 *  5. Removing (or pausing) a rule withdraws only its FUTURE UNBOOKED slots.
 *     Booked departures remain as one-offs; the past is never rewritten.
 *
 * Everything runs through a Prisma.TransactionClient so callers wrap it in
 * `withTenant(operatorId, tx => ...)` — RLS enforces isolation underneath, and the
 * plan that acts is always rebuilt from the database inside the write transaction.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** How far ahead rules materialize slots. Rolling: the cron sweep tops this up daily. */
export const RULE_HORIZON_DAYS = 60;

/** Hard ceiling on rows a single materialization may create (typo protection). */
const MAX_CREATES_PER_RUN = 5000;

// ---------------------------------------------------------------------------
// Timezone + calendar helpers (self-contained; Intl-based, no tz library)
// ---------------------------------------------------------------------------

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
}

function toLocalParts(instant: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  let hour = parseInt(map.hour ?? '0', 10);
  if (hour === 24) hour = 0;
  return {
    year: parseInt(map.year ?? '0', 10),
    month: parseInt(map.month ?? '1', 10),
    day: parseInt(map.day ?? '1', 10),
    hour,
    minute: parseInt(map.minute ?? '0', 10),
  };
}

/** Minutes to add to a UTC instant to get wall-clock time in `timeZone`. */
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const p = toLocalParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - instant.getTime()) / 60000);
}

function isoParts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return { y, m, d };
}

/** 0 = Sunday … 6 = Saturday for a YYYY-MM-DD calendar day (tz-agnostic). */
export function isoWeekday(iso: string): number {
  const { y, m, d } = isoParts(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Add whole days to a YYYY-MM-DD string (pure calendar arithmetic). */
export function addIsoDays(iso: string, days: number): string {
  const { y, m, d } = isoParts(iso);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(
    base.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** Today as YYYY-MM-DD in the given timezone. */
export function todayIsoIn(timeZone: string): string {
  const p = toLocalParts(new Date(), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The YYYY-MM-DD calendar day a stored UTC instant falls on in `timeZone`. */
function instantToIso(instant: Date, timeZone: string): string {
  const p = toLocalParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * The UTC instant of a wall-clock time on a local calendar day. Two-pass offset
 * correction so DST changeover days land on the right instant. On the
 * spring-forward day two wall-clock times can resolve to the same instant —
 * callers dedupe by epoch-ms.
 */
export function localTimeToUtc(iso: string, minutesOfDay: number, timeZone: string): Date {
  const { y, m, d } = isoParts(iso);
  const naive = Date.UTC(y, m - 1, d, Math.floor(minutesOfDay / 60), minutesOfDay % 60);
  const firstGuess = naive - tzOffsetMinutes(new Date(naive), timeZone) * 60000;
  return new Date(naive - tzOffsetMinutes(new Date(firstGuess), timeZone) * 60000);
}

// ---------------------------------------------------------------------------
// Pure expansion: rules -> desired departures (exported for unit tests)
// ---------------------------------------------------------------------------

/** The subset of a ScheduleRule row the expansion needs (draft rules match it too). */
export interface RuleLike {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  weekdays: number[];
  start_minutes: number[];
  capacity: number | null;
  is_active: boolean;
  /** Tiebreak for slot ownership when two rules share an instant. */
  created_at?: Date;
}

export interface DesiredOccurrence {
  /** Epoch ms of the UTC departure instant — the identity used for matching. */
  epochMs: number;
  datetimeUtc: Date;
  dayIso: string;
  minutes: number;
  capacity: number;
  /** The rule that owns the slot (earliest-created rule wins a shared instant). */
  ruleId: string;
}

export interface ExpandOptions {
  timeZone: string;
  /** Inclusive window of local calendar days to expand over. */
  windowStartIso: string;
  windowEndIso: string;
  /** Capacity used when a rule has no override (activity.max_participants). */
  defaultCapacity: number;
  /** Local days on which nothing may be generated. */
  blackoutDays?: ReadonlySet<string>;
}

/**
 * Expand active rules into the union of desired departures inside the window.
 * Composition: departures union across rules; where two rules land on the same
 * instant the HIGHEST capacity wins (never sell fewer seats than some rule allows)
 * and the earliest-created rule takes ownership for bookkeeping.
 */
export function expandDesiredOccurrences(
  rules: readonly RuleLike[],
  opts: ExpandOptions,
): Map<number, DesiredOccurrence> {
  const desired = new Map<number, DesiredOccurrence>();
  const ordered = [...rules]
    .filter((r) => r.is_active)
    .sort((a, b) => (a.created_at?.getTime() ?? 0) - (b.created_at?.getTime() ?? 0));

  for (const rule of ordered) {
    const weekdays = new Set(rule.weekdays);
    const capacity = Math.max(1, rule.capacity ?? opts.defaultCapacity);
    const from = rule.start_date > opts.windowStartIso ? rule.start_date : opts.windowStartIso;
    const to = rule.end_date < opts.windowEndIso ? rule.end_date : opts.windowEndIso;

    for (let iso = from; iso <= to; iso = addIsoDays(iso, 1)) {
      if (!weekdays.has(isoWeekday(iso))) continue;
      if (opts.blackoutDays?.has(iso)) continue;
      for (const minutes of rule.start_minutes) {
        const at = localTimeToUtc(iso, minutes, opts.timeZone);
        const key = at.getTime();
        const existing = desired.get(key);
        if (existing) {
          // Union of rules: keep first owner, sell the most generous capacity.
          if (capacity > existing.capacity) existing.capacity = capacity;
          continue;
        }
        desired.set(key, {
          epochMs: key,
          datetimeUtc: at,
          dayIso: iso,
          minutes,
          capacity,
          ruleId: rule.id,
        });
      }
    }
  }
  return desired;
}

// ---------------------------------------------------------------------------
// Blackouts
// ---------------------------------------------------------------------------

export interface BlackoutInfo {
  dayIso: string;
  reason: string | null;
  /** 'activity' when scoped to this activity, 'operator' otherwise. */
  scope: 'activity' | 'operator';
}

/**
 * The blackout days that apply to one activity inside a local-day window.
 * A row applies when it is scoped to this activity, or unscoped (activity_id null)
 * and either location-unscoped or scoped to the activity's location. The stored
 * UTC-midnight instant is read back as its ISO date — never through a timezone
 * projection, which would shift it a day west of Greenwich.
 */
export async function blackoutDaysForActivity(
  db: Prisma.TransactionClient,
  activity: { id: string; location_id: string | null },
  windowStartIso: string,
  windowEndIso: string,
): Promise<Map<string, BlackoutInfo>> {
  const startUtc = new Date(`${windowStartIso}T00:00:00.000Z`);
  const endUtc = new Date(`${addIsoDays(windowEndIso, 1)}T00:00:00.000Z`);
  const rows = await db.blackoutDate.findMany({
    where: {
      date: { gte: startUtc, lt: endUtc },
      OR: [
        { activity_id: activity.id },
        {
          activity_id: null,
          ...(activity.location_id
            ? { OR: [{ location_id: null }, { location_id: activity.location_id }] }
            : { location_id: null }),
        },
      ],
    },
    select: { date: true, reason: true, activity_id: true },
    orderBy: { date: 'asc' },
  });
  const out = new Map<string, BlackoutInfo>();
  for (const r of rows) {
    const dayIso = r.date.toISOString().slice(0, 10);
    const scope: BlackoutInfo['scope'] = r.activity_id ? 'activity' : 'operator';
    const existing = out.get(dayIso);
    // Activity-specific reasons are the more useful label when both exist.
    if (!existing || (existing.scope === 'operator' && scope === 'activity')) {
      out.set(dayIso, { dayIso, reason: r.reason, scope });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Planning + materialization
// ---------------------------------------------------------------------------

export interface MaterializeOptions {
  operatorId: string;
  activityId: string;
  /** Days ahead (from today, operator-local) to materialize. */
  horizonDays?: number;
  /** Preview drafts: plan as if THESE rules were saved (replaces the stored set). */
  rulesOverride?: RuleLike[];
  /**
   * Slot ids to treat as rule-managed even though schedule_rule_id is null —
   * used when a rule was just deleted and its slots were detached first (the FK
   * is NO ACTION, so detach-then-delete is the only order that works).
   */
  alsoManagedSlotIds?: readonly string[];
}

export interface PlannedSlotRef {
  slotId: string;
  dayIso: string;
  minutes: number;
}

export interface SchedulePlan {
  timeZone: string;
  todayIso: string;
  horizonEndIso: string;
  /** New departures the rules will create. */
  creates: DesiredOccurrence[];
  /** Rule-generated slots whose capacity changes (never below booked). */
  capacityUpdates: Array<PlannedSlotRef & { from: number; to: number }>;
  /** Slots whose owning rule changes (composition/edits) — bookkeeping only. */
  adoptions: Array<{ slotId: string; ruleId: string }>;
  /** Rule-generated future slots the rules no longer produce. */
  removals: Array<PlannedSlotRef & { mode: 'delete' | 'close' }>;
  /** Would be withdrawn but carry live bookings — left alone, called out. */
  protectedBooked: Array<PlannedSlotRef & { bookedSeats: number }>;
  /** Desired departures that already exist and stay as they are. */
  unchanged: PlannedSlotRef[];
  /** Desired departures skipped because the operator closed that time by hand. */
  keptClosed: PlannedSlotRef[];
  /** Blackout days inside the window (with reasons, for the preview). */
  blackouts: BlackoutInfo[];
  /** True when applying this plan would write nothing. */
  noChange: boolean;
}

/** A refusal meant to be read by the operator, as opposed to a bug. */
export class ScheduleRuleError extends Error {}

interface ActivityFacts {
  id: string;
  location_id: string | null;
  max_participants: number;
  timeZone: string;
  isOvernight: boolean;
}

async function readActivityFacts(
  db: Prisma.TransactionClient,
  operatorId: string,
  activityId: string,
): Promise<ActivityFacts> {
  const activity = await db.activity.findFirst({
    where: { id: activityId, operator_id: operatorId },
    select: {
      id: true,
      location_id: true,
      max_participants: true,
      location: { select: { timezone: true } },
      operator: { select: { timezone: true } },
    },
  });
  if (!activity) throw new ScheduleRuleError('That activity no longer exists.');
  // New slots keep doing whatever this activity's slots already do (same posture
  // as the one-off schedule editor): overnight is a property of the activity.
  const latest = await db.timeslot.findFirst({
    where: { activity_id: activityId, status: { not: 'CANCELLED' } },
    orderBy: { datetime: 'desc' },
    select: { is_overnight: true },
  });
  return {
    id: activity.id,
    location_id: activity.location_id,
    max_participants: activity.max_participants,
    timeZone: activity.location?.timezone ?? activity.operator.timezone,
    isOvernight: latest?.is_overnight ?? false,
  };
}

/**
 * Work out what materializing this activity's rules would do, without doing it.
 * Reads only. The same function runs inside the write transaction on apply, so the
 * plan that acts always reflects bookings taken since any preview was rendered.
 */
export async function planActivitySchedule(
  db: Prisma.TransactionClient,
  opts: MaterializeOptions,
): Promise<SchedulePlan> {
  const horizonDays = Math.min(Math.max(opts.horizonDays ?? RULE_HORIZON_DAYS, 1), 366);
  const facts = await readActivityFacts(db, opts.operatorId, opts.activityId);
  const todayIso = todayIsoIn(facts.timeZone);
  const horizonEndIso = addIsoDays(todayIso, horizonDays - 1);

  const storedRules = await db.scheduleRule.findMany({
    where: { activity_id: opts.activityId, operator_id: opts.operatorId },
    orderBy: { created_at: 'asc' },
  });
  const rules: RuleLike[] = opts.rulesOverride ?? storedRules;

  const blackoutMap = await blackoutDaysForActivity(db, facts, todayIso, horizonEndIso);
  const desired = expandDesiredOccurrences(rules, {
    timeZone: facts.timeZone,
    windowStartIso: todayIso,
    windowEndIso: horizonEndIso,
    defaultCapacity: facts.max_participants,
    blackoutDays: new Set(blackoutMap.keys()),
  });

  // Existing slots across the whole window, plus how many order lines hang off
  // each (ANY status — a refunded order is still history the FK protects).
  const windowStartUtc = localTimeToUtc(todayIso, 0, facts.timeZone);
  const windowEndUtc = localTimeToUtc(addIsoDays(horizonEndIso, 1), 0, facts.timeZone);
  const nowMs = Date.now();

  const [slots, lineCounts, liveSeats] = await Promise.all([
    db.timeslot.findMany({
      where: {
        activity_id: opts.activityId,
        datetime: { gte: windowStartUtc, lt: windowEndUtc },
      },
      select: {
        id: true,
        datetime: true,
        status: true,
        capacity_total: true,
        capacity_booked: true,
        schedule_rule_id: true,
      },
    }),
    db.orderItem.groupBy({
      by: ['timeslot_id'],
      where: {
        activity_id: opts.activityId,
        timeslot: { datetime: { gte: windowStartUtc, lt: windowEndUtc } },
      },
      _count: { _all: true },
    }),
    db.orderItem.groupBy({
      by: ['timeslot_id'],
      where: {
        activity_id: opts.activityId,
        status: { not: 'CANCELLED' },
        timeslot: { datetime: { gte: windowStartUtc, lt: windowEndUtc } },
      },
      _sum: { quantity: true },
    }),
  ]);

  const orderLines = new Map(lineCounts.map((r) => [r.timeslot_id, r._count._all]));
  const bookedSeats = new Map(liveSeats.map((r) => [r.timeslot_id, r._sum.quantity ?? 0]));
  const alsoManaged = new Set(opts.alsoManagedSlotIds ?? []);

  const plan: SchedulePlan = {
    timeZone: facts.timeZone,
    todayIso,
    horizonEndIso,
    creates: [],
    capacityUpdates: [],
    adoptions: [],
    removals: [],
    protectedBooked: [],
    unchanged: [],
    keptClosed: [],
    blackouts: [...blackoutMap.values()],
    noChange: false,
  };

  const byInstant = new Map<number, (typeof slots)[number]>();
  for (const slot of slots) byInstant.set(slot.datetime.getTime(), slot);

  // Pass 1 — every desired departure: create, keep, resize, or respect a closure.
  for (const occ of desired.values()) {
    const existing = byInstant.get(occ.epochMs);
    if (!existing) {
      // Never create a departure that has already sailed (today's earlier times).
      if (occ.epochMs >= nowMs) plan.creates.push(occ);
      continue;
    }
    const ref: PlannedSlotRef = { slotId: existing.id, dayIso: occ.dayIso, minutes: occ.minutes };
    if (occ.epochMs < nowMs) {
      // A departure that already sailed is history — never resized or re-owned.
      plan.unchanged.push(ref);
      continue;
    }
    if (existing.status === 'CANCELLED') {
      // The operator closed this time by hand; a rule never quietly re-opens it.
      plan.keptClosed.push(ref);
      continue;
    }
    const managed = existing.schedule_rule_id !== null || alsoManaged.has(existing.id);
    if (!managed) {
      // A one-off the operator (or the seed) created — rules keep their hands off.
      plan.unchanged.push(ref);
      continue;
    }
    const targetCapacity = Math.max(occ.capacity, existing.capacity_booked);
    if (existing.capacity_total !== targetCapacity) {
      plan.capacityUpdates.push({ ...ref, from: existing.capacity_total, to: targetCapacity });
    } else {
      plan.unchanged.push(ref);
    }
    if (existing.schedule_rule_id !== occ.ruleId) {
      plan.adoptions.push({ slotId: existing.id, ruleId: occ.ruleId });
    }
  }

  // Pass 2 — rule-managed slots the rules no longer produce: withdraw the future,
  // unbooked ones; protect everything else.
  for (const slot of slots) {
    const managed = slot.schedule_rule_id !== null || alsoManaged.has(slot.id);
    if (!managed) continue;
    if (desired.has(slot.datetime.getTime())) continue;
    if (slot.datetime.getTime() < nowMs) continue; // the past is never rewritten
    const ref: PlannedSlotRef = {
      slotId: slot.id,
      dayIso: instantToIso(slot.datetime, facts.timeZone),
      minutes: (() => {
        const p = toLocalParts(slot.datetime, facts.timeZone);
        return p.hour * 60 + p.minute;
      })(),
    };
    const seats = bookedSeats.get(slot.id) ?? 0;
    if (seats > 0) {
      plan.protectedBooked.push({ ...ref, bookedSeats: seats });
      continue;
    }
    if ((orderLines.get(slot.id) ?? 0) > 0) {
      // Only cancelled lines hang off it: history the FK protects. Close, not delete.
      if (slot.status !== 'CANCELLED') plan.removals.push({ ...ref, mode: 'close' });
      continue;
    }
    plan.removals.push({ ...ref, mode: 'delete' });
  }

  if (plan.creates.length > MAX_CREATES_PER_RUN) {
    throw new ScheduleRuleError(
      `That would create ${plan.creates.length.toLocaleString('en-US')} departures at once. ` +
        'Use fewer start times or a shorter season.',
    );
  }

  plan.noChange =
    plan.creates.length === 0 &&
    plan.capacityUpdates.length === 0 &&
    plan.adoptions.length === 0 &&
    plan.removals.length === 0;
  return plan;
}

export interface MaterializeResult {
  created: number;
  resized: number;
  removed: number;
  closed: number;
  protectedBooked: number;
  plan: SchedulePlan;
}

/**
 * Apply the rules: rebuild the plan from the database and write it. Idempotent —
 * running it twice in a row leaves the second run with nothing to do.
 */
export async function materializeActivitySchedule(
  db: Prisma.TransactionClient,
  opts: MaterializeOptions,
): Promise<MaterializeResult> {
  const plan = await planActivitySchedule(db, opts);
  const facts = await readActivityFacts(db, opts.operatorId, opts.activityId);

  if (plan.creates.length > 0) {
    await db.timeslot.createMany({
      data: plan.creates.map((occ) => ({
        operator_id: opts.operatorId,
        activity_id: opts.activityId,
        datetime: occ.datetimeUtc,
        capacity_total: occ.capacity,
        is_overnight: facts.isOvernight,
        status: 'AVAILABLE' as const,
        schedule_rule_id: occ.ruleId,
      })),
    });
  }

  for (const update of plan.capacityUpdates) {
    await db.timeslot.update({
      where: { id: update.slotId },
      data: { capacity_total: update.to },
    });
  }

  // Group ownership moves so this is one statement per rule, not per slot.
  if (plan.adoptions.length > 0) {
    const byRule = new Map<string, string[]>();
    for (const a of plan.adoptions) {
      const ids = byRule.get(a.ruleId);
      if (ids) ids.push(a.slotId);
      else byRule.set(a.ruleId, [a.slotId]);
    }
    for (const [ruleId, ids] of byRule) {
      await db.timeslot.updateMany({
        where: { id: { in: ids }, activity_id: opts.activityId },
        data: { schedule_rule_id: ruleId },
      });
    }
  }

  const deleteIds = plan.removals.filter((r) => r.mode === 'delete').map((r) => r.slotId);
  const closeIds = plan.removals.filter((r) => r.mode === 'close').map((r) => r.slotId);
  if (deleteIds.length > 0) {
    await db.timeslot.deleteMany({
      where: { id: { in: deleteIds }, activity_id: opts.activityId },
    });
  }
  if (closeIds.length > 0) {
    await db.timeslot.updateMany({
      where: { id: { in: closeIds }, activity_id: opts.activityId },
      data: { status: 'CANCELLED' },
    });
  }

  return {
    created: plan.creates.length,
    resized: plan.capacityUpdates.length,
    removed: deleteIds.length,
    closed: closeIds.length,
    protectedBooked: plan.protectedBooked.length,
    plan,
  };
}

/**
 * Delete a rule safely: detach its slots (the FK is NO ACTION), drop the rule row,
 * then re-materialize with the detached ids still treated as rule-managed so the
 * future unbooked ones are withdrawn — unless another rule still wants the same
 * departure, in which case that rule adopts them. Booked departures survive as
 * one-offs.
 */
export async function removeScheduleRule(
  db: Prisma.TransactionClient,
  opts: { operatorId: string; ruleId: string },
): Promise<MaterializeResult> {
  const rule = await db.scheduleRule.findFirst({
    where: { id: opts.ruleId, operator_id: opts.operatorId },
    select: { id: true, activity_id: true },
  });
  if (!rule) throw new ScheduleRuleError('That schedule no longer exists.');

  const owned = await db.timeslot.findMany({
    where: { schedule_rule_id: rule.id },
    select: { id: true },
  });
  const ownedIds = owned.map((s) => s.id);
  if (ownedIds.length > 0) {
    await db.timeslot.updateMany({
      where: { id: { in: ownedIds } },
      data: { schedule_rule_id: null },
    });
  }
  await db.scheduleRule.delete({ where: { id: rule.id } });

  return materializeActivitySchedule(db, {
    operatorId: opts.operatorId,
    activityId: rule.activity_id,
    alsoManagedSlotIds: ownedIds,
  });
}
