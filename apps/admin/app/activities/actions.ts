'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  activityInputSchema,
  rateInputSchema,
  createId,
  computeSlotStatus,
  generateTimeslots,
  type SlotStatus,
} from '@marina/core';
import { Prisma, withTenant } from '@marina/database';
import { z } from 'zod';
import { addIsoDays, localDayRangeUtc, toLocalParts } from '../../components/manifest/tz';
import { getTenantDb, requirePermission } from '../../lib/session';

/**
 * Server actions for the activities slice. Every mutation:
 *  - requires the `activity:write` permission (throws AuthorizationError otherwise),
 *  - runs through the tenant-scoped client (RLS enforces operator isolation), and
 *  - still writes an explicit `operator_id` where-clause as defense in depth.
 *
 * The wizard persists an Activity plus its child Rates together. Rates are
 * validated with @marina/core's rateInputSchema (minus activity_id, which we own
 * server-side) and reconciled (create / update / delete) against what exists.
 */

/** A per-head rate class submitted with a rate. `id` present => existing row. */
const wizardRateClassSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.enum(['ADULT', 'CHILD', 'INFANT', 'YOUTH', 'SENIOR', 'OTHER']).default('OTHER'),
  label: z.string().trim().min(1, 'Label is required').max(80),
  /** Signed delta on the rate base, integer cents (may be negative). */
  price_modifier_cents: z.number().int(),
  is_active: z.boolean().default(true),
});

/** A rate as submitted by the wizard. `id` present => existing row to update. */
const wizardRateSchema = rateInputSchema
  .omit({ activity_id: true })
  .extend({
    id: z.string().min(1).optional(),
    rate_classes: z.array(wizardRateClassSchema).default([]),
  });

/**
 * Per-channel opt-OUT visibility flags (and hide_price). These layer on top of the
 * core `visible_*` opt-in flags: when true the activity is suppressed from that
 * surface. They live on the Activity model but are added to the input shape here so
 * the admin wizard can persist them without a core schema bump.
 */
const channelFlagsSchema = z.object({
  hide_from_register: z.boolean().default(false),
  hide_from_display: z.boolean().default(false),
  hide_from_kiosk: z.boolean().default(false),
  hide_price: z.boolean().default(false),
});

/** The full wizard payload: activity fields (+ channel flags) + its rates. */
const wizardSchema = z.object({
  activity: activityInputSchema.and(channelFlagsSchema),
  rates: z.array(wizardRateSchema).default([]),
});

export type WizardInput = z.infer<typeof wizardSchema>;

export interface ActionResult {
  ok: boolean;
  /** Field-path -> message, suitable for surfacing inline in the form. */
  errors?: Record<string, string>;
  /** General error message when not field-specific. */
  message?: string;
  /** Created/updated activity id (on success). */
  activityId?: string;
}

/**
 * Coerce the validated config object into a Prisma JSON value. `null`/`undefined`
 * map to `Prisma.JsonNull` so an existing config can be cleared on update.
 */
function toJsonConfig(
  config: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (config == null) return Prisma.JsonNull;
  return config as Prisma.InputJsonValue;
}

/** Flatten a ZodError into a `path -> message` map the client can consume. */
function zodErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    if (!(path in out)) out[path] = issue.message;
  }
  return out;
}

/**
 * Create a new Activity (+ its Rates) for the current operator.
 * Redirects to the edit page on success.
 */
export async function createActivity(input: WizardInput): Promise<ActionResult> {
  const { operatorId } = await requirePermission('activity:write');

  const parsed = wizardSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: zodErrors(parsed.error) };
  }
  const { activity, rates } = parsed.data;

  const db = await getTenantDb();

  // If a location was supplied, ensure it belongs to this operator (RLS already
  // guarantees this, but we fail loudly rather than persisting a dangling ref).
  if (activity.location_id) {
    const loc = await db.location.findFirst({
      where: { id: activity.location_id, operator_id: operatorId },
      select: { id: true },
    });
    if (!loc) {
      return { ok: false, errors: { 'activity.location_id': 'Unknown location.' } };
    }
  }

  const activityId = createId();

  await db.activity.create({
    data: {
      id: activityId,
      operator_id: operatorId,
      location_id: activity.location_id ?? null,
      name_internal: activity.name_internal,
      name_external: activity.name_external,
      category: activity.category,
      status: activity.status,
      visible_online: activity.visible_online,
      visible_kiosk: activity.visible_kiosk,
      visible_register: activity.visible_register,
      hide_from_register: activity.hide_from_register,
      hide_from_display: activity.hide_from_display,
      hide_from_kiosk: activity.hide_from_kiosk,
      hide_price: activity.hide_price,
      min_participants: activity.min_participants,
      max_participants: activity.max_participants,
      description_html: activity.description_html ?? null,
      photo_urls: activity.photo_urls,
      color: activity.color,
      waiver_required: activity.waiver_required,
      self_reschedule_hours: activity.self_reschedule_hours,
      sort_index: activity.sort_index,
      config: toJsonConfig(activity.config),
      rates: {
        create: rates.map((r, i) => ({
          id: createId(),
          operator_id: operatorId,
          name_internal: r.name_internal,
          name_external: r.name_external,
          price_cents: r.price_cents,
          duration_minutes: r.duration_minutes,
          is_active: r.is_active,
          online_only: r.online_only,
          internal_only: r.internal_only,
          is_from_price: r.is_from_price,
          sort_index: r.sort_index || i,
          // Per-head rate classes nested under the rate. operator_id is carried
          // explicitly (RLS + the tenant-composite FK both require it); the parent
          // rate's id is supplied by Prisma via the nested write.
          rate_classes: {
            create: r.rate_classes.map((rc, j) => ({
              id: createId(),
              operator_id: operatorId,
              kind: rc.kind,
              label: rc.label,
              price_modifier_cents: rc.price_modifier_cents,
              is_active: rc.is_active,
              sort_index: j,
            })),
          },
        })),
      },
    },
  });

  revalidatePath('/activities');
  redirect(`/activities/${activityId}`);
}

/**
 * Update an existing Activity (+ reconcile its Rates) for the current operator.
 */
export async function updateActivity(
  activityId: string,
  input: WizardInput,
): Promise<ActionResult> {
  const { operatorId } = await requirePermission('activity:write');

  const parsed = wizardSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: zodErrors(parsed.error) };
  }
  const { activity, rates } = parsed.data;

  const db = await getTenantDb();

  // Confirm the activity exists and belongs to this operator before mutating.
  const existing = await db.activity.findFirst({
    where: { id: activityId, operator_id: operatorId },
    select: {
      id: true,
      rates: { select: { id: true, rate_classes: { select: { id: true } } } },
    },
  });
  if (!existing) {
    return { ok: false, message: 'Activity not found.' };
  }
  // Existing rate-class ids per rate, for the nested reconcile below.
  const existingClassIdsByRate = new Map<string, Set<string>>(
    existing.rates.map((r) => [r.id, new Set(r.rate_classes.map((c) => c.id))]),
  );

  if (activity.location_id) {
    const loc = await db.location.findFirst({
      where: { id: activity.location_id, operator_id: operatorId },
      select: { id: true },
    });
    if (!loc) {
      return { ok: false, errors: { 'activity.location_id': 'Unknown location.' } };
    }
  }

  const existingRateIds = new Set(existing.rates.map((r) => r.id));
  const submittedRateIds = new Set(
    rates.map((r) => r.id).filter((id): id is string => Boolean(id)),
  );
  const toDelete = [...existingRateIds].filter((id) => !submittedRateIds.has(id));

  await db.activity.update({
    where: { id: activityId },
    data: {
      location_id: activity.location_id ?? null,
      name_internal: activity.name_internal,
      name_external: activity.name_external,
      category: activity.category,
      status: activity.status,
      visible_online: activity.visible_online,
      visible_kiosk: activity.visible_kiosk,
      visible_register: activity.visible_register,
      hide_from_register: activity.hide_from_register,
      hide_from_display: activity.hide_from_display,
      hide_from_kiosk: activity.hide_from_kiosk,
      hide_price: activity.hide_price,
      min_participants: activity.min_participants,
      max_participants: activity.max_participants,
      description_html: activity.description_html ?? null,
      photo_urls: activity.photo_urls,
      color: activity.color,
      waiver_required: activity.waiver_required,
      self_reschedule_hours: activity.self_reschedule_hours,
      sort_index: activity.sort_index,
      config: toJsonConfig(activity.config),
      rates: {
        // Remove rates the user deleted in the wizard.
        deleteMany: toDelete.length ? { id: { in: toDelete } } : undefined,
        // Update rates that already existed (scoped by id within this activity).
        update: rates
          .filter((r) => r.id && existingRateIds.has(r.id))
          .map((r) => {
            // Reconcile this rate's per-head classes the same way rates are:
            // delete only the ones the user removed, update existing by id, create
            // new. A RESTRICT FK from OrderItem.rate_class_id means a class already
            // sold on an order can't be hard-deleted — so we never blanket-replace;
            // the user deactivates (is_active=false) such a class instead.
            const existingClassIds = existingClassIdsByRate.get(r.id!) ?? new Set<string>();
            const submittedClassIds = new Set(
              r.rate_classes.map((c) => c.id).filter((id): id is string => Boolean(id)),
            );
            const classesToDelete = [...existingClassIds].filter((id) => !submittedClassIds.has(id));
            return {
              where: { id: r.id! },
              data: {
                name_internal: r.name_internal,
                name_external: r.name_external,
                price_cents: r.price_cents,
                duration_minutes: r.duration_minutes,
                is_active: r.is_active,
                online_only: r.online_only,
                internal_only: r.internal_only,
                is_from_price: r.is_from_price,
                sort_index: r.sort_index,
                rate_classes: {
                  deleteMany: classesToDelete.length ? { id: { in: classesToDelete } } : undefined,
                  update: r.rate_classes
                    .filter((c) => c.id && existingClassIds.has(c.id))
                    .map((c) => ({
                      where: { id: c.id! },
                      data: {
                        kind: c.kind,
                        label: c.label,
                        price_modifier_cents: c.price_modifier_cents,
                        is_active: c.is_active,
                      },
                    })),
                  create: r.rate_classes
                    .filter((c) => !c.id)
                    .map((c, j) => ({
                      id: createId(),
                      operator_id: operatorId,
                      kind: c.kind,
                      label: c.label,
                      price_modifier_cents: c.price_modifier_cents,
                      is_active: c.is_active,
                      sort_index: j,
                    })),
                },
              },
            };
          }),
        // Create brand-new rates.
        create: rates
          .filter((r) => !r.id)
          .map((r, i) => ({
            id: createId(),
            operator_id: operatorId,
            name_internal: r.name_internal,
            name_external: r.name_external,
            price_cents: r.price_cents,
            duration_minutes: r.duration_minutes,
            is_active: r.is_active,
            online_only: r.online_only,
            internal_only: r.internal_only,
            is_from_price: r.is_from_price,
            sort_index: r.sort_index || i,
            rate_classes: {
              create: r.rate_classes.map((c, j) => ({
                id: createId(),
                operator_id: operatorId,
                kind: c.kind,
                label: c.label,
                price_modifier_cents: c.price_modifier_cents,
                is_active: c.is_active,
                sort_index: j,
              })),
            },
          })),
      },
    },
  });

  revalidatePath('/activities');
  revalidatePath(`/activities/${activityId}`);
  return { ok: true, activityId };
}

/** Toggle an activity between ACTIVE and INACTIVE. */
export async function toggleActivityStatus(activityId: string): Promise<ActionResult> {
  const { operatorId } = await requirePermission('activity:write');
  const db = await getTenantDb();

  const existing = await db.activity.findFirst({
    where: { id: activityId, operator_id: operatorId },
    select: { status: true },
  });
  if (!existing) return { ok: false, message: 'Activity not found.' };

  await db.activity.update({
    where: { id: activityId },
    data: { status: existing.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' },
  });

  revalidatePath('/activities');
  revalidatePath(`/activities/${activityId}`);
  return { ok: true, activityId };
}

/** Toggle a single online/kiosk/register visibility flag. */
export async function toggleActivityVisibility(
  activityId: string,
  channel: 'online' | 'kiosk' | 'register',
): Promise<ActionResult> {
  const { operatorId } = await requirePermission('activity:write');
  const db = await getTenantDb();

  const field =
    channel === 'online'
      ? 'visible_online'
      : channel === 'kiosk'
        ? 'visible_kiosk'
        : 'visible_register';

  const existing = await db.activity.findFirst({
    where: { id: activityId, operator_id: operatorId },
    select: { visible_online: true, visible_kiosk: true, visible_register: true },
  });
  if (!existing) return { ok: false, message: 'Activity not found.' };

  await db.activity.update({
    where: { id: activityId },
    data: { [field]: !existing[field] },
  });

  revalidatePath('/activities');
  revalidatePath(`/activities/${activityId}`);
  return { ok: true, activityId };
}

// ---------------------------------------------------------------------------
// Schedule editing for an activity that already exists
//
// Operating hours used to live only inside the create wizard, so an operator set
// them once and could never change them: summer hours could not differ from spring,
// and a boat going in for service for three weeks was a job for a developer. These
// actions make hours, days of the week and closed dates editable for a DATE RANGE on
// the activity itself, which for a marina is the normal case rather than the
// exception.
//
// Two rules shape every line below.
//
//  1. NOTHING RUNS WITHOUT A PREVIEW THE OPERATOR HAS READ. `planScheduleChange`
//     returns exactly what a run would do, in plain words. `applyScheduleChange`
//     rebuilds that same plan from the database inside the write transaction and acts
//     on the rebuilt one — the preview is a thing to read, never an input to trust.
//     If someone books a seat between the preview and the confirm, the rebuilt plan
//     sees it.
//
//  2. A DAY THAT HAS BOOKINGS ON IT IS NEVER TOUCHED. Not regenerated, not closed.
//     Deleting a timeslot an order line points at would erase somebody's Saturday, so
//     those days come back marked BLOCKED, and a run that would have hit them refuses
//     outright until the operator ticks the box that says to skip them. "Has bookings"
//     deliberately counts cancelled order lines too: a refunded order is still history
//     hanging off that row, and the foreign key would refuse the delete anyway.
//
// Timeslots are stored as UTC instants and operated in the operator's (or the
// location's) timezone, so every day/hour decision here goes through the shared tz
// helpers rather than the server's own locale.
// ---------------------------------------------------------------------------

/** Which of the three schedule operations a plan describes. */
export type ScheduleOperation = 'GENERATE' | 'CLOSE' | 'REOPEN';

/** What will happen to one calendar day. */
export type ScheduleDayAction =
  /** Had no times; gets the new ones. */
  | 'CREATE'
  /** Had times with nothing booked; they are removed and rebuilt. */
  | 'REPLACE'
  /** Already had times and the operator chose to leave those days alone. */
  | 'KEEP'
  /** Has bookings on it. Left exactly as it is, whatever was asked for. */
  | 'BLOCKED'
  /** Closed already; a regeneration must not quietly re-open it. */
  | 'LEFT_CLOSED'
  /** Its times are being switched off. */
  | 'CLOSE'
  /** Its closed times are being switched back on. */
  | 'REOPEN';

export interface ScheduleDayPlan {
  /** YYYY-MM-DD in the operator timezone. */
  date: string;
  /** "Sat, Jul 4" — built here so the browser never redoes the timezone math. */
  label: string;
  action: ScheduleDayAction;
  /** Bookable start times on that day today. */
  timesNow: number;
  /** Bookable start times on that day once this runs. */
  timesAfter: number;
  /** Seats already booked on that day. */
  bookings: number;
}

export interface SchedulePlan {
  ok: boolean;
  /** Set only when no plan could be built at all (bad dates, activity gone). */
  message?: string;
  operation: ScheduleOperation;
  timezone: string;
  /** One sentence the operator can read out loud. */
  headline: string;
  /** The rest of the story, one plain sentence per line. */
  lines: string[];
  /** The start times each generated day gets, e.g. ["9:00 AM", "1:00 PM"]. */
  startTimes: string[];
  daysChanged: number;
  timesCreated: number;
  timesRemoved: number;
  timesClosed: number;
  timesReopened: number;
  /** Days skipped because bookings sit on them. */
  blockedDays: ScheduleDayPlan[];
  /** Every day this plan has something to say about. */
  days: ScheduleDayPlan[];
  /** True when the operator must accept skipping the booked days before this can run. */
  needsDecision: boolean;
  /** True when running this would change nothing at all. */
  noChange: boolean;
}

export interface ScheduleApplyResult {
  ok: boolean;
  message: string;
  /** What was actually done, rebuilt server-side. Absent when the input was rejected. */
  plan?: SchedulePlan;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A season can be a year long, but not longer — the same cap the API applies. */
const MAX_RANGE_DAYS = 366;

/**
 * Ceiling on how many start times one run may create. 366 days of five-minute slots
 * is over a hundred thousand rows; a typo in the interval box should be refused with
 * a sentence, not absorbed silently.
 */
const MAX_TIMES_PER_RUN = 5000;

const dateRangeSchema = z
  .object({
    activityId: z.string().trim().min(1),
    startDate: z.string().regex(ISO_DATE_RE, 'Pick a start date.'),
    endDate: z.string().regex(ISO_DATE_RE, 'Pick an end date.'),
    /** Proceed even though some days are being skipped for having bookings. */
    acknowledgeBookedDays: z.boolean().default(false),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: 'The end date has to be on or after the start date.',
    path: ['endDate'],
  });

const generateSchema = dateRangeSchema.and(
  z
    .object({
      openHour: z.number().int().min(0).max(23),
      closeHour: z.number().int().min(1).max(24),
      intervalMinutes: z
        .number()
        .int()
        .min(5, 'Leave at least 5 minutes between start times.')
        .max(24 * 60),
      capacityPerSlot: z
        .number()
        .int()
        .min(1, 'At least one person has to be able to book.')
        .max(999),
      /** 0 = Sunday … 6 = Saturday, in the operator's timezone. */
      weekdays: z
        .array(z.number().int().min(0).max(6))
        .min(1, 'Pick at least one day of the week.'),
      /** What to do with days in the range that already have times on them. */
      existingDays: z.enum(['keep', 'replace']),
    })
    .refine((v) => v.closeHour > v.openHour, {
      message: 'Closing time has to be after opening time.',
      path: ['closeHour'],
    }),
);

export type GenerateScheduleInput = z.infer<typeof generateSchema>;
export type CloseDatesInput = z.infer<typeof dateRangeSchema>;

// --- Plain-language date + time labels -------------------------------------
//
// Built from the YYYY-MM-DD parts rather than by parsing the string into a Date:
// `new Date('2026-07-04')` is UTC midnight, which renders as July 3rd for anyone west
// of Greenwich. A calendar day the operator typed must never move under him.

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAY_LONG = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
] as const;
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function isoParts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return { y, m, d };
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD calendar day. */
function isoWeekday(iso: string): number {
  const { y, m, d } = isoParts(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * "Sat Jul 4". No comma after the weekday on purpose: these labels get joined into
 * comma-separated lists ("Sat Jul 4, Mon Jul 6"), and an internal comma turns that
 * into soup nobody can count.
 */
function isoLabel(iso: string): string {
  const { m, d } = isoParts(iso);
  return `${WEEKDAY_SHORT[isoWeekday(iso)]} ${MONTH_SHORT[m - 1]} ${d}`;
}

/** "Jul 4, 2026" — used where the year matters (range ends, season summaries). */
function isoLongLabel(iso: string): string {
  const { y, m, d } = isoParts(iso);
  return `${MONTH_SHORT[m - 1]} ${d}, ${y}`;
}

/** "9:00 AM" from minutes since local midnight. */
function timeLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

/** "Fridays, Saturdays and Sundays" */
function weekdayPhrase(days: number[]): string {
  const names = [...new Set(days)].sort((a, b) => a - b).map((d) => WEEKDAY_LONG[d]);
  if (names.length === 0) return 'no days';
  if (names.length === 7) return 'every day';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "3 start times" / "1 start time" — plural agreement without a library. */
function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`;
}

/** Verb agreement for a counted subject, so "4 days already has" never ships. */
function hasHave(count: number): string {
  return count === 1 ? 'has' : 'have';
}

/** Object agreement for the same counted subject. */
function itThem(count: number): string {
  return count === 1 ? 'it' : 'them';
}

/**
 * "from Jun 1, 2026 to Sep 30, 2026", collapsing to "on Jul 4, 2026" for a single day.
 * The preposition is part of the phrase so every sentence built from it reads properly
 * in both cases — "between Jun 1 to Sep 30" was the alternative.
 */
function rangePhrase(startDate: string, endDate: string): string {
  return startDate === endDate
    ? `on ${isoLongLabel(startDate)}`
    : `from ${isoLongLabel(startDate)} to ${isoLongLabel(endDate)}`;
}

// --- Timezone math ---------------------------------------------------------

/** Minutes to add to a UTC instant to get local wall-clock time in `timeZone`. */
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const p = toLocalParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/** The YYYY-MM-DD calendar day a stored instant falls on, in the operator's timezone. */
function instantToIso(instant: Date, timeZone: string): string {
  const p = toLocalParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * The UTC instant for a wall-clock time on a local calendar day. Two passes: the
 * offset has to be measured at the instant we actually land on, or every start time
 * on a daylight-saving changeover day is written an hour out.
 */
function localTimeToUtc(iso: string, minutesOfDay: number, timeZone: string): Date {
  const { y, m, d } = isoParts(iso);
  const naive = Date.UTC(y, m - 1, d, Math.floor(minutesOfDay / 60), minutesOfDay % 60);
  const firstGuess = naive - tzOffsetMinutes(new Date(naive), timeZone) * 60000;
  return new Date(naive - tzOffsetMinutes(new Date(firstGuess), timeZone) * 60000);
}

/** Whole days between two YYYY-MM-DD dates, as pure calendar arithmetic. */
function daysBetween(startDate: string, endDate: string): number {
  const a = isoParts(startDate);
  const b = isoParts(endDate);
  return Math.round(
    (Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000,
  );
}

/** Walk a YYYY-MM-DD range inclusively. */
function eachDay(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  for (let iso = startDate; iso <= endDate; iso = addIsoDays(iso, 1)) out.push(iso);
  return out;
}

// --- Reading the current state of a range ----------------------------------

/** One stored timeslot, reduced to what the planner needs in order to decide. */
interface SlotFact {
  id: string;
  /** Minutes since local midnight. */
  minutes: number;
  capacityTotal: number;
  capacityBooked: number;
  cancelled: boolean;
  /** Order lines pointing at this slot, ANY status. Non-zero means never delete it. */
  orderLines: number;
  /** Seats held by order lines that are not cancelled. */
  bookedSeats: number;
}

interface DayFacts {
  open: SlotFact[];
  closed: SlotFact[];
  /** Seats booked across the whole day. */
  bookedSeats: number;
  /** True when any slot that day carries an order line. */
  hasOrders: boolean;
}

interface RangeContext {
  timeZone: string;
  /** Whether this activity's slots run overnight, copied from what it already does. */
  isOvernight: boolean;
  /** Local calendar day -> what is on it right now. Only days with slots appear. */
  byDay: Map<string, DayFacts>;
}

/** A refusal the operator is meant to read, as opposed to a bug. */
class ScheduleError extends Error {}

/**
 * Load everything in [startDate, endDate] the planner reasons about: the activity's
 * timezone, its slots bucketed by local calendar day, and how many order lines hang
 * off each one.
 *
 * Reads only, and takes a plain transaction client so the identical function serves
 * both the preview (against the tenant client) and the apply (inside the write
 * transaction, where its answer is the one that counts).
 */
async function readRange(
  db: Prisma.TransactionClient,
  operatorId: string,
  activityId: string,
  startDate: string,
  endDate: string,
): Promise<RangeContext> {
  if (daysBetween(startDate, endDate) + 1 > MAX_RANGE_DAYS) {
    throw new ScheduleError(
      `That is more than a year of dates. Do it a season at a time (up to ${MAX_RANGE_DAYS} days).`,
    );
  }

  const activity = await db.activity.findFirst({
    where: { id: activityId, operator_id: operatorId },
    select: {
      id: true,
      location: { select: { timezone: true } },
      operator: { select: { timezone: true } },
    },
  });
  if (!activity) throw new ScheduleError('That activity no longer exists.');

  const timeZone = activity.location?.timezone ?? activity.operator.timezone;
  const startUtc = localDayRangeUtc(startDate, timeZone).startUtc;
  const endUtc = localDayRangeUtc(endDate, timeZone).endUtc;

  const [slots, latestSlot, allLines, liveLines] = await Promise.all([
    db.timeslot.findMany({
      where: { activity_id: activityId, datetime: { gte: startUtc, lt: endUtc } },
      select: {
        id: true,
        datetime: true,
        status: true,
        capacity_total: true,
        capacity_booked: true,
      },
      orderBy: { datetime: 'asc' },
    }),
    // Overnight is a property of the activity, not a question to re-ask the operator
    // on every schedule change: new slots keep doing whatever this one already does.
    db.timeslot.findFirst({
      where: { activity_id: activityId, status: { not: 'CANCELLED' } },
      orderBy: { datetime: 'desc' },
      select: { is_overnight: true },
    }),
    db.orderItem.groupBy({
      by: ['timeslot_id'],
      where: { activity_id: activityId, timeslot: { datetime: { gte: startUtc, lt: endUtc } } },
      _count: { _all: true },
    }),
    db.orderItem.groupBy({
      by: ['timeslot_id'],
      where: {
        activity_id: activityId,
        status: { not: 'CANCELLED' },
        timeslot: { datetime: { gte: startUtc, lt: endUtc } },
      },
      _sum: { quantity: true },
    }),
  ]);

  const lineCount = new Map(allLines.map((r) => [r.timeslot_id, r._count._all]));
  const seatCount = new Map(liveLines.map((r) => [r.timeslot_id, r._sum.quantity ?? 0]));

  const byDay = new Map<string, DayFacts>();
  for (const slot of slots) {
    const iso = instantToIso(slot.datetime, timeZone);
    const parts = toLocalParts(slot.datetime, timeZone);
    const fact: SlotFact = {
      id: slot.id,
      minutes: parts.hour * 60 + parts.minute,
      capacityTotal: slot.capacity_total,
      capacityBooked: slot.capacity_booked,
      cancelled: slot.status === 'CANCELLED',
      orderLines: lineCount.get(slot.id) ?? 0,
      bookedSeats: seatCount.get(slot.id) ?? 0,
    };
    let day = byDay.get(iso);
    if (!day) {
      day = { open: [], closed: [], bookedSeats: 0, hasOrders: false };
      byDay.set(iso, day);
    }
    (fact.cancelled ? day.closed : day.open).push(fact);
    day.bookedSeats += fact.bookedSeats;
    if (fact.orderLines > 0) day.hasOrders = true;
  }

  return { timeZone, isOvernight: latestSlot?.is_overnight ?? false, byDay };
}

// --- Building the plan -----------------------------------------------------

/** Everything the apply step needs on top of the human-readable plan. */
interface PlannedWork {
  plan: SchedulePlan;
  /** Slot ids to delete outright — only ever slots carrying no order lines at all. */
  deleteIds: string[];
  /** Slot ids to switch off. */
  closeIds: string[];
  /** Slots to switch back on, with the numbers their status recomputes from. */
  reopen: Array<{ id: string; capacityTotal: number; capacityBooked: number }>;
  /** New rows to insert. */
  create: Array<{ datetime: Date; capacityTotal: number }>;
}

function emptyWork(operation: ScheduleOperation, timeZone: string): PlannedWork {
  return {
    plan: {
      ok: true,
      operation,
      timezone: timeZone,
      headline: '',
      lines: [],
      startTimes: [],
      daysChanged: 0,
      timesCreated: 0,
      timesRemoved: 0,
      timesClosed: 0,
      timesReopened: 0,
      blockedDays: [],
      days: [],
      needsDecision: false,
      noChange: false,
    },
    deleteIds: [],
    closeIds: [],
    reopen: [],
    create: [],
  };
}

/** Build one day's row of the preview table. */
function dayEntry(
  iso: string,
  action: ScheduleDayAction,
  timesNow: number,
  timesAfter: number,
  bookings: number,
): ScheduleDayPlan {
  return { date: iso, label: isoLabel(iso), action, timesNow, timesAfter, bookings };
}

/**
 * Work out what setting these hours across this range would do, without doing it.
 *
 * The order of the checks is the whole safety argument:
 *   1. a day outside the chosen days of the week is not in the plan at all;
 *   2. a day carrying order lines is BLOCKED before any other rule can claim it;
 *   3. a day that is currently closed stays closed — regenerating a season must never
 *      quietly re-open the Saturday he shut for a storm;
 *   4. only then does "leave alone" or "replace" get to decide.
 */
function planGenerate(ctx: RangeContext, input: GenerateScheduleInput): PlannedWork {
  const work = emptyWork('GENERATE', ctx.timeZone);
  const plan = work.plan;

  // The times one day gets. Generated with the same @marina/core helper the create
  // wizard and the API use, so what is previewed here is what lands in the table.
  const template = generateTimeslots({
    openHour: input.openHour,
    closeHour: input.closeHour,
    intervalMinutes: input.intervalMinutes,
    capacityTotal: input.capacityPerSlot,
    // Any calendar day: only the time-of-day components are read back out.
    date: new Date(2026, 0, 1),
  });
  const templateMinutes = template.map(
    (s) => s.datetime.getHours() * 60 + s.datetime.getMinutes(),
  );
  plan.startTimes = templateMinutes.map(timeLabel);

  if (templateMinutes.length === 0) {
    plan.ok = false;
    plan.message = 'Those hours produce no start times. Check the opening and closing times.';
    plan.headline = plan.message;
    return work;
  }

  const weekdays = new Set(input.weekdays);
  let daysKept = 0;
  let daysLeftClosed = 0;

  for (const iso of eachDay(input.startDate, input.endDate)) {
    if (!weekdays.has(isoWeekday(iso))) continue;

    const day = ctx.byDay.get(iso);
    const timesNow = day?.open.length ?? 0;
    const bookings = day?.bookedSeats ?? 0;

    if (day?.hasOrders) {
      const blocked = dayEntry(iso, 'BLOCKED', timesNow, timesNow, bookings);
      plan.blockedDays.push(blocked);
      plan.days.push(blocked);
      continue;
    }

    if (day && day.open.length === 0 && day.closed.length > 0) {
      daysLeftClosed += 1;
      plan.days.push(dayEntry(iso, 'LEFT_CLOSED', 0, 0, bookings));
      continue;
    }

    if (timesNow > 0 && input.existingDays === 'keep') {
      daysKept += 1;
      plan.days.push(dayEntry(iso, 'KEEP', timesNow, timesNow, bookings));
      continue;
    }

    // CREATE (nothing there) or REPLACE (times there, nothing booked on them).
    const seen = new Set<number>();
    let added = 0;
    for (const minutes of templateMinutes) {
      const at = localTimeToUtc(iso, minutes, ctx.timeZone);
      // On the spring-forward day two wall-clock times can resolve to one instant.
      // Drop the duplicate rather than writing the same start time twice.
      if (seen.has(at.getTime())) continue;
      seen.add(at.getTime());
      work.create.push({ datetime: at, capacityTotal: input.capacityPerSlot });
      added += 1;
    }
    if (timesNow > 0 && day) {
      for (const slot of day.open) work.deleteIds.push(slot.id);
      plan.timesRemoved += timesNow;
      plan.days.push(dayEntry(iso, 'REPLACE', timesNow, added, bookings));
    } else {
      plan.days.push(dayEntry(iso, 'CREATE', 0, added, bookings));
    }
    plan.timesCreated += added;
    plan.daysChanged += 1;
  }

  if (plan.timesCreated > MAX_TIMES_PER_RUN) {
    plan.ok = false;
    plan.message = `That would create ${plan.timesCreated.toLocaleString(
      'en-US',
    )} start times. Use a shorter stretch of dates, or a longer gap between start times.`;
    plan.headline = plan.message;
    return work;
  }

  // A "replace" that would have wiped a booked day is the dangerous case: he asked for
  // something we are refusing to do in full, so he has to say the smaller job is fine.
  plan.needsDecision = input.existingDays === 'replace' && plan.blockedDays.length > 0;
  plan.noChange = plan.daysChanged === 0;

  const range = rangePhrase(input.startDate, input.endDate);
  plan.headline = plan.noChange
    ? `Nothing would change ${range}.`
    : `${plural(plan.daysChanged, 'day')} ${range} would get ${plural(
        plan.timesCreated,
        'start time',
      )}.`;

  plan.lines.push(
    `Open ${weekdayPhrase(input.weekdays)} at ${plan.startTimes.join(', ')}. ${plural(
      input.capacityPerSlot,
      'person',
      'people',
    )} can book each start time.`,
  );
  if (plan.timesRemoved > 0) {
    plan.lines.push(
      `${plural(
        plan.timesRemoved,
        'existing start time',
      )} with nothing booked will be removed and rebuilt with the new hours.`,
    );
  }
  if (daysKept > 0) {
    plan.lines.push(
      `${plural(daysKept, 'day')} already had times and will be left exactly as ${
        daysKept === 1 ? 'it is' : 'they are'
      }.`,
    );
  }
  if (daysLeftClosed > 0) {
    plan.lines.push(
      `${plural(daysLeftClosed, 'day')} you closed will stay closed — this will not re-open them.`,
    );
  }
  return work;
}

/** Switch off every bookable time on the chosen days. Days with bookings are refused. */
function planClose(ctx: RangeContext, input: CloseDatesInput): PlannedWork {
  const work = emptyWork('CLOSE', ctx.timeZone);
  const plan = work.plan;
  let daysWithNothing = 0;
  let daysAlreadyClosed = 0;

  for (const iso of eachDay(input.startDate, input.endDate)) {
    const day = ctx.byDay.get(iso);
    const timesNow = day?.open.length ?? 0;
    const bookings = day?.bookedSeats ?? 0;

    if (day?.hasOrders) {
      const blocked = dayEntry(iso, 'BLOCKED', timesNow, timesNow, bookings);
      plan.blockedDays.push(blocked);
      plan.days.push(blocked);
      continue;
    }
    if (timesNow === 0 || !day) {
      if (day && day.closed.length > 0) {
        daysAlreadyClosed += 1;
        plan.days.push(dayEntry(iso, 'LEFT_CLOSED', 0, 0, bookings));
      } else {
        daysWithNothing += 1;
      }
      continue;
    }

    for (const slot of day.open) work.closeIds.push(slot.id);
    plan.timesClosed += timesNow;
    plan.daysChanged += 1;
    plan.days.push(dayEntry(iso, 'CLOSE', timesNow, 0, bookings));
  }

  // Closing is what people reach for in a hurry, so a booked day stops it outright
  // rather than being quietly worked around.
  plan.needsDecision = plan.blockedDays.length > 0;
  plan.noChange = plan.daysChanged === 0;

  const range = rangePhrase(input.startDate, input.endDate);
  // "Nothing to close" and "everything here is booked" are very different answers, and
  // the second one is the one he needs to act on.
  if (plan.noChange && plan.blockedDays.length > 0) {
    plan.headline = `Nothing can be closed ${range} — ${
      plan.blockedDays.length === 1 ? 'that day has' : 'those days have'
    } bookings on ${itThem(plan.blockedDays.length)}.`;
  } else if (plan.noChange) {
    plan.headline = `There is nothing to close ${range}.`;
  } else {
    plan.headline = `${plural(plan.daysChanged, 'day')} would close, taking ${plural(
      plan.timesClosed,
      'start time',
    )} off the calendar.`;
  }
  plan.lines.push('This closes this activity only. Everything else you run stays open.');
  plan.lines.push('You can open these days back up whenever you want.');
  if (daysAlreadyClosed > 0) {
    plan.lines.push(
      `${plural(daysAlreadyClosed, 'day')} in this stretch ${
        daysAlreadyClosed === 1 ? 'is' : 'are'
      } already closed.`,
    );
  }
  if (daysWithNothing > 0) {
    plan.lines.push(
      `${plural(daysWithNothing, 'day')} had no times on ${itThem(
        daysWithNothing,
      )} to begin with.`,
    );
  }
  return work;
}

/** Switch closed times back on, restoring each slot's status from its own numbers. */
function planReopen(ctx: RangeContext, input: CloseDatesInput): PlannedWork {
  const work = emptyWork('REOPEN', ctx.timeZone);
  const plan = work.plan;

  for (const iso of eachDay(input.startDate, input.endDate)) {
    const day = ctx.byDay.get(iso);
    if (!day || day.closed.length === 0) continue;
    for (const slot of day.closed) {
      work.reopen.push({
        id: slot.id,
        capacityTotal: slot.capacityTotal,
        capacityBooked: slot.capacityBooked,
      });
    }
    plan.timesReopened += day.closed.length;
    plan.daysChanged += 1;
    plan.days.push(
      dayEntry(iso, 'REOPEN', day.open.length, day.open.length + day.closed.length, day.bookedSeats),
    );
  }

  plan.noChange = plan.daysChanged === 0;
  const range = rangePhrase(input.startDate, input.endDate);
  plan.headline = plan.noChange
    ? `Nothing is closed ${range}.`
    : `${plural(plan.daysChanged, 'day')} would open back up, putting ${plural(
        plan.timesReopened,
        'start time',
      )} back on the calendar.`;
  plan.lines.push('Guests will be able to book these times again straight away.');
  return work;
}

/** Build the plan for whichever operation was asked for. */
function buildPlan(
  ctx: RangeContext,
  operation: ScheduleOperation,
  input: GenerateScheduleInput | CloseDatesInput,
): PlannedWork {
  if (operation === 'GENERATE') return planGenerate(ctx, input as GenerateScheduleInput);
  if (operation === 'CLOSE') return planClose(ctx, input);
  return planReopen(ctx, input);
}

/** Validate whichever payload shape this operation carries. */
function parseScheduleInput(
  operation: ScheduleOperation,
  input: unknown,
):
  | { ok: true; value: GenerateScheduleInput | CloseDatesInput }
  | { ok: false; message: string } {
  const parsed =
    operation === 'GENERATE' ? generateSchema.safeParse(input) : dateRangeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the dates and times.' };
  }
  return { ok: true, value: parsed.data };
}

function refusedPlan(operation: ScheduleOperation, message: string): SchedulePlan {
  const plan = emptyWork(operation, '').plan;
  plan.ok = false;
  plan.message = message;
  plan.headline = message;
  return plan;
}

/**
 * Work out what a schedule change would do and hand it back unexecuted. Writes
 * nothing. Gated by `activity:write` exactly like the mutations, because the answer
 * describes a calendar and must never be readable by someone who cannot edit it.
 */
export async function planScheduleChange(
  operation: ScheduleOperation,
  input: unknown,
): Promise<SchedulePlan> {
  const { operatorId } = await requirePermission('activity:write');

  const parsed = parseScheduleInput(operation, input);
  if (!parsed.ok) return refusedPlan(operation, parsed.message);

  const db = await getTenantDb();
  try {
    // The tenant client carries the same delegates as a transaction client at runtime;
    // only the static types differ, because of the RLS extension. Reads only here.
    const ctx = await readRange(
      db as unknown as Prisma.TransactionClient,
      operatorId,
      parsed.value.activityId,
      parsed.value.startDate,
      parsed.value.endDate,
    );
    return buildPlan(ctx, operation, parsed.value).plan;
  } catch (err) {
    if (err instanceof ScheduleError) return refusedPlan(operation, err.message);
    throw err;
  }
}

/**
 * Carry out a schedule change.
 *
 * The plan is rebuilt from the database inside the write transaction, and it is the
 * rebuilt plan that acts — a booking taken between the operator reading the preview
 * and pressing the button is seen, and that day drops out of the work. If rebuilding
 * turns up booked days he has not agreed to skip, nothing is written at all.
 */
export async function applyScheduleChange(
  operation: ScheduleOperation,
  input: unknown,
): Promise<ScheduleApplyResult> {
  const { operatorId } = await requirePermission('activity:write');

  const parsed = parseScheduleInput(operation, input);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const value = parsed.value;

  let result: ScheduleApplyResult;
  try {
    result = await withTenant(operatorId, async (tx) => {
      const ctx = await readRange(tx, operatorId, value.activityId, value.startDate, value.endDate);
      const work = buildPlan(ctx, operation, value);
      const plan = work.plan;

      if (!plan.ok) {
        return { ok: false, message: plan.message ?? 'That could not be worked out.', plan };
      }

      if (plan.needsDecision && !value.acknowledgeBookedDays) {
        const names = plan.blockedDays.map((d) => d.label).join(', ');
        return {
          ok: false,
          message: `${plural(plan.blockedDays.length, 'day')} already ${hasHave(
            plan.blockedDays.length,
          )} bookings on ${itThem(
            plan.blockedDays.length,
          )} (${names}). Nothing has been changed. Either move those bookings first, or tick the box to go ahead with the other days and leave those alone.`,
          plan,
        };
      }

      if (plan.noChange) return { ok: true, message: plan.headline, plan };

      if (work.deleteIds.length > 0) {
        // Every id here came off a day the planner proved carries no order lines at
        // all. The activity_id guard is defence in depth on top of RLS.
        await tx.timeslot.deleteMany({
          where: { id: { in: work.deleteIds }, activity_id: value.activityId },
        });
      }

      if (work.create.length > 0) {
        await tx.timeslot.createMany({
          data: work.create.map((row) => ({
            id: createId(),
            operator_id: operatorId,
            activity_id: value.activityId,
            datetime: row.datetime,
            capacity_total: row.capacityTotal,
            is_overnight: ctx.isOvernight,
            status: computeSlotStatus(row.capacityTotal, 0),
          })),
        });
      }

      if (work.closeIds.length > 0) {
        await tx.timeslot.updateMany({
          where: { id: { in: work.closeIds }, activity_id: value.activityId },
          data: { status: 'CANCELLED' },
        });
      }

      if (work.reopen.length > 0) {
        // Re-opening restores each slot's real status from its own capacity numbers
        // rather than blanket-setting AVAILABLE, so a slot that was full before it was
        // closed comes back full. Grouped so this is three statements, not N.
        const byStatus = new Map<SlotStatus, string[]>();
        for (const slot of work.reopen) {
          const status = computeSlotStatus(slot.capacityTotal, slot.capacityBooked);
          const ids = byStatus.get(status);
          if (ids) ids.push(slot.id);
          else byStatus.set(status, [slot.id]);
        }
        for (const [status, ids] of byStatus) {
          await tx.timeslot.updateMany({
            where: { id: { in: ids }, activity_id: value.activityId },
            data: { status },
          });
        }
      }

      return { ok: true, message: describeOutcome(plan), plan };
    });
  } catch (err) {
    if (err instanceof ScheduleError) return { ok: false, message: err.message };
    throw err;
  }

  if (result.ok) {
    revalidatePath('/activities');
    revalidatePath(`/activities/${value.activityId}`);
    revalidatePath('/calendar');
    revalidatePath('/manifest');
  }
  return result;
}

/** The past-tense sentence shown once a change has actually gone through. */
function describeOutcome(plan: SchedulePlan): string {
  const parts: string[] = [];
  if (plan.timesCreated > 0) {
    parts.push(
      `added ${plural(plan.timesCreated, 'start time')} across ${plural(plan.daysChanged, 'day')}`,
    );
  }
  if (plan.timesRemoved > 0) parts.push(`replaced ${plural(plan.timesRemoved, 'old start time')}`);
  if (plan.timesClosed > 0) {
    parts.push(
      `closed ${plural(plan.daysChanged, 'day')} (${plural(plan.timesClosed, 'start time')})`,
    );
  }
  if (plan.timesReopened > 0) {
    parts.push(
      `opened ${plural(plan.daysChanged, 'day')} back up (${plural(
        plan.timesReopened,
        'start time',
      )})`,
    );
  }
  const done = parts.length > 0 ? `Done — ${parts.join(', ')}.` : 'Done.';
  if (plan.blockedDays.length > 0) {
    const count = plan.blockedDays.length;
    return `${done} ${plural(count, 'day')} with bookings ${
      count === 1 ? 'was' : 'were'
    } left untouched: ${plan.blockedDays.map((d) => d.label).join(', ')}.`;
  }
  return done;
}
