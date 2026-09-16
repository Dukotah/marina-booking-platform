'use server';

/**
 * Server actions for the repeating-schedule builder (RuleScheduler).
 *
 * A ScheduleRule is the FareHarbor-style recipe — "Summer weekdays: Mon–Fri at
 * 8:00, 10:00 and 2:00, up to 10 guests, May 1 through Sep 30" — and the engine
 * in @marina/database (packages/database/src/schedule.ts) turns recipes into
 * Timeslot rows over a rolling horizon. These actions are thin: validate, write
 * the recipe, materialize inside the same withTenant transaction, and hand the
 * component a plain-language summary plus a two-week preview it can show BEFORE
 * anything is saved.
 *
 * Every mutation requires `activity:write` and runs tenant-scoped (RLS).
 */
import { revalidatePath } from 'next/cache';
import {
  Prisma,
  withTenant,
  materializeActivitySchedule,
  planActivitySchedule,
  removeScheduleRule,
  ScheduleRuleError,
  type RuleLike,
  type SchedulePlan,
} from '@marina/database';
import { z } from 'zod';
import { addIsoDays } from '../../components/manifest/tz';
import { getTenantDb, requirePermission } from '../../lib/session';

/** Days the preview calendar shows. Materialization still fills the full horizon. */
const PREVIEW_DAYS = 14;

/** Longest closed-dates range one add may create (a season of Sundays is rules' job). */
const MAX_BLACKOUT_RANGE_DAYS = 62;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ruleInputSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1, 'Give this schedule a name.').max(80),
    startDate: z.string().regex(ISO_DATE_RE, 'Pick a first date.'),
    endDate: z.string().regex(ISO_DATE_RE, 'Pick a last date.'),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1, 'Pick at least one day of the week.'),
    startMinutes: z
      .array(z.number().int().min(0).max(24 * 60 - 1))
      .min(1, 'Add at least one departure time.')
      .max(24, 'That is more departure times than hours in the day.'),
    /** null = follow the boat's capacity (activity.max_participants). */
    capacity: z.number().int().min(1).max(999).nullable(),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: 'The last date has to be on or after the first date.',
    path: ['endDate'],
  });

export type RuleInput = z.infer<typeof ruleInputSchema>;

/** One saved rule, shaped for the component. */
export interface RuleView {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  weekdays: number[];
  startMinutes: number[];
  capacity: number | null;
  isActive: boolean;
}

export interface PreviewTime {
  minutes: number;
  /**
   * What the rules would do with this departure:
   *  - create:  will be added to the calendar
   *  - exists:  already on the calendar and stays
   *  - removed: on the calendar today, withdrawn by this change (nothing booked)
   *  - booked:  would be withdrawn but has bookings — left alone
   *  - closed:  the operator closed this time by hand; it stays closed
   */
  kind: 'create' | 'exists' | 'removed' | 'booked' | 'closed';
}

export interface PreviewDay {
  date: string;
  blackoutReason: string | null;
  /** 'activity' | 'operator' | null — who owns the blackout, for the label. */
  blackoutScope: 'activity' | 'operator' | null;
  times: PreviewTime[];
}

export interface SchedulePreview {
  ok: boolean;
  message?: string;
  timezone: string;
  days: PreviewDay[];
  /** One plain sentence: what saving would do across the whole horizon. */
  headline: string;
  /** Departures that carry bookings and are therefore protected. */
  protectedCount: number;
}

export interface RuleActionResult {
  ok: boolean;
  message: string;
  /** Field-path -> message for inline display. */
  errors?: Record<string, string>;
}

function zodErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    if (!(path in out)) out[path] = issue.message;
  }
  return out;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`;
}

/** Turn an engine plan into the component's two-week preview grid. */
function planToPreview(plan: SchedulePlan): SchedulePreview {
  const byDay = new Map<string, PreviewDay>();
  const start = plan.todayIso;
  for (let i = 0; i < PREVIEW_DAYS; i += 1) {
    const date = addIsoDays(start, i);
    byDay.set(date, { date, blackoutReason: null, blackoutScope: null, times: [] });
  }
  for (const b of plan.blackouts) {
    const day = byDay.get(b.dayIso);
    if (day) {
      day.blackoutReason = b.reason ?? (b.scope === 'operator' ? 'Closed' : 'Closed');
      day.blackoutScope = b.scope;
    }
  }
  const push = (dayIso: string, minutes: number, kind: PreviewTime['kind']) => {
    const day = byDay.get(dayIso);
    if (day) day.times.push({ minutes, kind });
  };
  for (const c of plan.creates) push(c.dayIso, c.minutes, 'create');
  for (const u of plan.unchanged) push(u.dayIso, u.minutes, 'exists');
  for (const u of plan.capacityUpdates) push(u.dayIso, u.minutes, 'exists');
  for (const r of plan.removals) push(r.dayIso, r.minutes, 'removed');
  for (const p of plan.protectedBooked) push(p.dayIso, p.minutes, 'booked');
  for (const k of plan.keptClosed) push(k.dayIso, k.minutes, 'closed');

  const days = [...byDay.values()];
  for (const day of days) day.times.sort((a, b) => a.minutes - b.minutes);

  const created = plan.creates.length;
  const removed = plan.removals.length;
  const headline =
    created === 0 && removed === 0
      ? 'The calendar already matches — saving changes nothing.'
      : [
          created > 0 ? `${plural(created, 'departure')} will be added` : null,
          removed > 0 ? `${plural(removed, 'empty departure')} will come off` : null,
        ]
          .filter(Boolean)
          .join(' and ') + ' over the next 60 days.';

  return {
    ok: true,
    timezone: plan.timeZone,
    days,
    headline,
    protectedCount: plan.protectedBooked.length,
  };
}

/** Stored rules -> RuleLike, with a draft replacing/adding its own id. */
function withDraft(stored: RuleView[], draft: RuleInput | null, removeId?: string): RuleLike[] {
  const rules: RuleLike[] = stored
    .filter((r) => r.id !== removeId && r.id !== draft?.id)
    .map((r, i) => ({
      id: r.id,
      name: r.name,
      start_date: r.startDate,
      end_date: r.endDate,
      weekdays: r.weekdays,
      start_minutes: r.startMinutes,
      capacity: r.capacity,
      is_active: r.isActive,
      created_at: new Date(i), // preserve stored order for ownership tiebreaks
    }));
  if (draft) {
    rules.push({
      id: draft.id ?? '__draft__',
      name: draft.name,
      start_date: draft.startDate,
      end_date: draft.endDate,
      weekdays: draft.weekdays,
      start_minutes: [...draft.startMinutes].sort((a, b) => a - b),
      capacity: draft.capacity,
      is_active: draft.isActive,
      created_at: new Date(stored.length + 1),
    });
  }
  return rules;
}

async function loadRuleViews(activityId: string): Promise<RuleView[]> {
  const db = await getTenantDb();
  const rows = await db.scheduleRule.findMany({
    where: { activity_id: activityId },
    orderBy: { created_at: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    weekdays: r.weekdays,
    startMinutes: r.start_minutes,
    capacity: r.capacity,
    isActive: r.is_active,
  }));
}

/**
 * What would the calendar look like if `draft` were saved (or `removeRuleId`
 * removed)? Read-only; the same planner runs again inside the write transaction
 * on save, so this is a picture to read, never an input to trust.
 */
export async function previewSchedule(
  activityId: string,
  draft: RuleInput | null,
  removeRuleId?: string,
): Promise<SchedulePreview> {
  const { operatorId } = await requirePermission('activity:write');

  let parsedDraft: RuleInput | null = null;
  if (draft) {
    const parsed = ruleInputSchema.safeParse(draft);
    if (!parsed.success) {
      return {
        ok: false,
        message: parsed.error.issues[0]?.message ?? 'Check the schedule details.',
        timezone: '',
        days: [],
        headline: '',
        protectedCount: 0,
      };
    }
    parsedDraft = parsed.data;
  }

  const stored = await loadRuleViews(activityId);
  const db = await getTenantDb();
  try {
    const plan = await planActivitySchedule(db as unknown as Prisma.TransactionClient, {
      operatorId,
      activityId,
      rulesOverride: withDraft(stored, parsedDraft, removeRuleId),
    });
    return planToPreview(plan);
  } catch (err) {
    if (err instanceof ScheduleRuleError) {
      return {
        ok: false,
        message: err.message,
        timezone: '',
        days: [],
        headline: '',
        protectedCount: 0,
      };
    }
    throw err;
  }
}

/** Create or update a rule, then fill the calendar in the same transaction. */
export async function saveScheduleRule(
  activityId: string,
  input: RuleInput,
): Promise<RuleActionResult> {
  const { operatorId } = await requirePermission('activity:write');

  const parsed = ruleInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: 'Check the highlighted fields.', errors: zodErrors(parsed.error) };
  }
  const rule = parsed.data;
  const startMinutes = [...new Set(rule.startMinutes)].sort((a, b) => a - b);

  try {
    const result = await withTenant(operatorId, async (tx) => {
      const data = {
        name: rule.name,
        start_date: rule.startDate,
        end_date: rule.endDate,
        weekdays: [...new Set(rule.weekdays)].sort((a, b) => a - b),
        start_minutes: startMinutes,
        capacity: rule.capacity,
        is_active: rule.isActive,
      };
      if (rule.id) {
        const existing = await tx.scheduleRule.findFirst({
          where: { id: rule.id, activity_id: activityId, operator_id: operatorId },
          select: { id: true },
        });
        if (!existing) throw new ScheduleRuleError('That schedule no longer exists.');
        await tx.scheduleRule.update({ where: { id: rule.id }, data });
      } else {
        await tx.scheduleRule.create({
          data: { ...data, operator_id: operatorId, activity_id: activityId },
        });
      }
      return materializeActivitySchedule(tx, { operatorId, activityId });
    });

    revalidatePath(`/activities/${activityId}`);
    revalidatePath('/calendar');
    const bits = [
      result.created > 0 ? `added ${plural(result.created, 'departure')}` : null,
      result.removed + result.closed > 0
        ? `took ${plural(result.removed + result.closed, 'empty departure')} off`
        : null,
      result.resized > 0 ? `updated capacity on ${plural(result.resized, 'departure')}` : null,
    ].filter(Boolean);
    return {
      ok: true,
      message:
        bits.length > 0
          ? `Saved. This ${bits.join(', ')} across the next 60 days.`
          : 'Saved. The calendar already matched this schedule.',
    };
  } catch (err) {
    if (err instanceof ScheduleRuleError) return { ok: false, message: err.message };
    throw err;
  }
}

/** Pause or resume a rule. Pausing withdraws its future unbooked departures. */
export async function setScheduleRuleActive(
  activityId: string,
  ruleId: string,
  isActive: boolean,
): Promise<RuleActionResult> {
  const { operatorId } = await requirePermission('activity:write');
  try {
    const result = await withTenant(operatorId, async (tx) => {
      const existing = await tx.scheduleRule.findFirst({
        where: { id: ruleId, activity_id: activityId, operator_id: operatorId },
        select: { id: true },
      });
      if (!existing) throw new ScheduleRuleError('That schedule no longer exists.');
      await tx.scheduleRule.update({ where: { id: ruleId }, data: { is_active: isActive } });
      return materializeActivitySchedule(tx, { operatorId, activityId });
    });
    revalidatePath(`/activities/${activityId}`);
    revalidatePath('/calendar');
    return {
      ok: true,
      message: isActive
        ? `Resumed. ${plural(result.created, 'departure')} went back on the calendar.`
        : `Paused. ${plural(result.removed + result.closed, 'empty departure')} came off; anything booked stays.`,
    };
  } catch (err) {
    if (err instanceof ScheduleRuleError) return { ok: false, message: err.message };
    throw err;
  }
}

/** Remove a rule. Only its future, unbooked departures come off the calendar. */
export async function deleteScheduleRule(
  activityId: string,
  ruleId: string,
): Promise<RuleActionResult> {
  const { operatorId } = await requirePermission('activity:write');
  try {
    const result = await withTenant(operatorId, (tx) =>
      removeScheduleRule(tx, { operatorId, ruleId }),
    );
    revalidatePath(`/activities/${activityId}`);
    revalidatePath('/calendar');
    const kept = result.protectedBooked;
    return {
      ok: true,
      message:
        kept > 0
          ? `Removed. ${plural(result.removed + result.closed, 'empty departure')} came off; ${plural(kept, 'booked departure')} stayed put.`
          : `Removed. ${plural(result.removed + result.closed, 'empty departure')} came off the calendar.`,
    };
  } catch (err) {
    if (err instanceof ScheduleRuleError) return { ok: false, message: err.message };
    throw err;
  }
}

/**
 * Copy another activity's schedule onto this one: replaces this activity's rules
 * with copies of the source's, then refills the calendar. Bookings and one-off
 * slots are untouched, as always.
 */
export async function copyScheduleFrom(
  activityId: string,
  sourceActivityId: string,
): Promise<RuleActionResult> {
  const { operatorId } = await requirePermission('activity:write');
  if (sourceActivityId === activityId) {
    return { ok: false, message: 'Pick a different boat to copy from.' };
  }
  try {
    const { copied, result } = await withTenant(operatorId, async (tx) => {
      const source = await tx.scheduleRule.findMany({
        where: { activity_id: sourceActivityId, operator_id: operatorId },
        orderBy: { created_at: 'asc' },
      });
      if (source.length === 0) {
        throw new ScheduleRuleError('That boat has no repeating schedule to copy yet.');
      }
      const mine = await tx.scheduleRule.findMany({
        where: { activity_id: activityId, operator_id: operatorId },
        select: { id: true },
      });
      for (const rule of mine) {
        await removeScheduleRule(tx, { operatorId, ruleId: rule.id });
      }
      for (const rule of source) {
        await tx.scheduleRule.create({
          data: {
            operator_id: operatorId,
            activity_id: activityId,
            name: rule.name,
            start_date: rule.start_date,
            end_date: rule.end_date,
            weekdays: rule.weekdays,
            start_minutes: rule.start_minutes,
            // Capacity overrides travel with the copy; null keeps following THIS
            // boat's own capacity, which is what makes copying across sizes safe.
            capacity: rule.capacity,
            is_active: rule.is_active,
          },
        });
      }
      const result = await materializeActivitySchedule(tx, { operatorId, activityId });
      return { copied: source.length, result };
    });
    revalidatePath(`/activities/${activityId}`);
    revalidatePath('/calendar');
    return {
      ok: true,
      message: `Copied ${plural(copied, 'schedule')} over and added ${plural(result.created, 'departure')}.`,
    };
  } catch (err) {
    if (err instanceof ScheduleRuleError) return { ok: false, message: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Closed dates (blackouts)
// ---------------------------------------------------------------------------

/**
 * Re-materialize one activity — or, when `activityId` is null, every activity
 * with an active rule — one short tenant transaction each. Returns the number of
 * departures withdrawn (default) or created, for the outcome sentence.
 */
async function rematerialize(
  operatorId: string,
  activityId: string | null,
  count: 'withdrawn' | 'created' = 'withdrawn',
): Promise<number> {
  const db = await getTenantDb();
  const targets = activityId
    ? [activityId]
    : (
        await db.scheduleRule.groupBy({ by: ['activity_id'], where: { is_active: true } })
      ).map((g) => g.activity_id);
  let total = 0;
  for (const target of targets) {
    const result = await withTenant(operatorId, (tx) =>
      materializeActivitySchedule(tx, { operatorId, activityId: target }),
    );
    total += count === 'created' ? result.created : result.removed + result.closed;
  }
  return total;
}

const blackoutInputSchema = z
  .object({
    /** null = the whole marina (every activity), else just this activity. */
    activityId: z.string().trim().min(1).nullable(),
    startDate: z.string().regex(ISO_DATE_RE, 'Pick a first date.'),
    endDate: z.string().regex(ISO_DATE_RE, 'Pick a last date.'),
    reason: z.string().trim().max(200).optional(),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: 'The last date has to be on or after the first date.',
    path: ['endDate'],
  });

export type BlackoutInput = z.infer<typeof blackoutInputSchema>;

/** Add closed dates. `contextActivityId` is the page to refresh + materialize. */
export async function addBlackout(
  contextActivityId: string,
  input: BlackoutInput,
): Promise<RuleActionResult> {
  const { operatorId } = await requirePermission('activity:write');

  const parsed = blackoutInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: 'Check the highlighted fields.', errors: zodErrors(parsed.error) };
  }
  const { activityId, startDate, endDate, reason } = parsed.data;

  const days: string[] = [];
  for (let iso = startDate; iso <= endDate; iso = addIsoDays(iso, 1)) {
    days.push(iso);
    if (days.length > MAX_BLACKOUT_RANGE_DAYS) {
      return {
        ok: false,
        message: `That is more than ${MAX_BLACKOUT_RANGE_DAYS} days. For a recurring pattern (say, closed Mondays), edit the schedule instead.`,
      };
    }
  }

  try {
    await withTenant(operatorId, async (tx) => {
      // Skip days already closed with the same scope, so re-adding is harmless.
      const existing = await tx.blackoutDate.findMany({
        where: {
          activity_id: activityId,
          date: {
            gte: new Date(`${startDate}T00:00:00.000Z`),
            lte: new Date(`${endDate}T00:00:00.000Z`),
          },
        },
        select: { date: true },
      });
      const have = new Set(existing.map((b) => b.date.toISOString().slice(0, 10)));
      const rows = days
        .filter((iso) => !have.has(iso))
        .map((iso) => ({
          operator_id: operatorId,
          activity_id: activityId,
          date: new Date(`${iso}T00:00:00.000Z`),
          reason: reason || null,
        }));
      if (rows.length > 0) await tx.blackoutDate.createMany({ data: rows });
    });

    // Withdraw the rule-generated departures the blackout now covers. Marina-wide
    // blackouts touch every activity with a repeating schedule. One short
    // transaction per activity (idempotent), never one long one that could time
    // out halfway through the fleet.
    const withdrawn = await rematerialize(operatorId, activityId);

    revalidatePath(`/activities/${contextActivityId}`);
    revalidatePath('/calendar');
    const scopeWord = activityId ? 'this boat' : 'the whole marina';
    return {
      ok: true,
      message: `Closed ${plural(days.length, 'day')} for ${scopeWord}. ${plural(withdrawn, 'empty departure')} came off; anything booked stays until you deal with it.`,
    };
  } catch (err) {
    if (err instanceof ScheduleRuleError) return { ok: false, message: err.message };
    throw err;
  }
}

/** Re-open a stretch of closed dates (delete the blackout rows, refill the calendar). */
export async function removeBlackout(
  contextActivityId: string,
  ids: string[],
): Promise<RuleActionResult> {
  const { operatorId } = await requirePermission('activity:write');
  if (ids.length === 0) return { ok: false, message: 'Nothing to re-open.' };

  try {
    const scopes = await withTenant(operatorId, async (tx) => {
      const rows = await tx.blackoutDate.findMany({
        where: { id: { in: ids }, operator_id: operatorId },
        select: { id: true, activity_id: true },
      });
      if (rows.length === 0) throw new ScheduleRuleError('Those closed dates are already gone.');
      await tx.blackoutDate.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      return new Set(rows.map((r) => r.activity_id));
    });

    let restored = 0;
    if (scopes.has(null)) {
      restored = await rematerialize(operatorId, null, 'created');
    } else {
      for (const scope of scopes) {
        if (scope) restored += await rematerialize(operatorId, scope, 'created');
      }
    }

    revalidatePath(`/activities/${contextActivityId}`);
    revalidatePath('/calendar');
    return {
      ok: true,
      message: `Re-opened. ${plural(restored, 'departure')} went back on the calendar.`,
    };
  } catch (err) {
    if (err instanceof ScheduleRuleError) return { ok: false, message: err.message };
    throw err;
  }
}
