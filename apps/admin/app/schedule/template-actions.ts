'use server';

/**
 * Schedule Template Designer — server actions.
 *
 * The designer is a per-activity WEEKLY TEMPLATE: a grid of departure times
 * (rows) × weekdays (SUN..SAT, columns). Each (time, weekday) cell is either on
 * or off, and an on-cell carries a capacity. That grid is a projection of the
 * activity's departure ScheduleRules — see schedule-rules-actions.ts for the
 * underlying model.
 *
 * REPLACE semantics for departures: saving the template rebuilds the activity's
 * *departure* rules from scratch (one rule per distinct time-row), leaving any
 * open-duration rental-window rules (open/close set, no start_minutes) untouched.
 * The materializer then fills the calendar in the same transaction, so the board
 * and the template never disagree.
 *
 * Every mutation requires `activity:write` and runs tenant-scoped (RLS).
 */
import { revalidatePath } from 'next/cache';
import {
  withTenant,
  materializeActivitySchedule,
  ScheduleRuleError,
} from '@marina/database';
import { z } from 'zod';
import { getTenantDb, requirePermission } from '../../lib/session';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_OF_DAY = 24 * 60 - 1;

/** One template row: a departure time and the weekdays/capacity it fires on. */
const rowSchema = z.object({
  /** Minutes since local midnight (e.g. 540 = 9:00 AM). */
  minute: z.number().int().min(0).max(MIN_OF_DAY),
  /** Weekdays this time is active on: 0 = Sun … 6 = Sat. */
  weekdays: z.array(z.number().int().min(0).max(6)),
  /** Guests per departure for this row. null = follow the boat's capacity. */
  capacity: z.number().int().min(1).max(999).nullable(),
});

const templatePayloadSchema = z.object({
  /** Template label stored as the name on every generated departure rule. */
  name: z.string().trim().min(1, 'Give the template a name.').max(80),
  /** Inclusive season bounds (YYYY-MM-DD, activity-local). */
  startDate: z.string().regex(ISO_DATE_RE, 'Pick a first date.'),
  endDate: z.string().regex(ISO_DATE_RE, 'Pick a last date.'),
  rows: z.array(rowSchema),
});

export type TemplateRowInput = z.infer<typeof rowSchema>;
export type TemplatePayload = z.infer<typeof templatePayloadSchema>;

export interface TemplateActionResult {
  ok: boolean;
  message: string;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Rebuild this activity's DEPARTURE schedule from the edited grid, then refill
 * the calendar — all in one tenant transaction.
 *
 * Departure rules are reconciled with REPLACE semantics: every existing rule
 * that carries fixed departure times (start_minutes non-empty) is deleted and
 * re-created from the grid, one rule per distinct time-row. Rows with at least
 * one weekday toggled on survive; a row with every day off drops out entirely.
 * Rental-window rules (open/close set, no start_minutes) are never touched here.
 */
export async function saveScheduleTemplate(
  activityId: string,
  payload: TemplatePayload,
): Promise<TemplateActionResult> {
  const { operatorId } = await requirePermission('activity:write');

  const parsed = templatePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the template details.' };
  }
  const { name, startDate, endDate, rows } = parsed.data;
  if (endDate < startDate) {
    return { ok: false, message: 'The last date has to be on or after the first date.' };
  }

  // Keep only rows that are active on at least one day; a fully-off row is a
  // deleted time. De-dupe by minute so the grid can never ask for two rules at
  // the same departure time.
  const liveRows = new Map<number, TemplateRowInput>();
  for (const row of rows) {
    const weekdays = [...new Set(row.weekdays)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
    if (weekdays.length === 0) continue;
    liveRows.set(row.minute, { minute: row.minute, weekdays, capacity: row.capacity });
  }

  try {
    const result = await withTenant(operatorId, async (tx) => {
      // Load every rule so we can tell departures (replace) from rental windows
      // (leave alone). A departure rule is one with fixed start_minutes.
      const existing = await tx.scheduleRule.findMany({
        where: { activity_id: activityId, operator_id: operatorId },
        select: { id: true, start_minutes: true },
      });
      const departureIds = existing
        .filter((r) => r.start_minutes.length > 0)
        .map((r) => r.id);
      if (departureIds.length > 0) {
        await tx.scheduleRule.deleteMany({ where: { id: { in: departureIds } } });
      }

      for (const row of liveRows.values()) {
        await tx.scheduleRule.create({
          data: {
            operator_id: operatorId,
            activity_id: activityId,
            name,
            start_date: startDate,
            end_date: endDate,
            weekdays: row.weekdays,
            start_minutes: [row.minute],
            open_minute: null,
            close_minute: null,
            capacity: row.capacity,
            is_active: true,
          },
        });
      }

      return materializeActivitySchedule(tx, { operatorId, activityId });
    });

    revalidatePath('/schedule');
    revalidatePath(`/activities/${activityId}`);
    revalidatePath('/calendar');

    const bits = [
      result.created > 0 ? `added ${plural(result.created, 'departure')}` : null,
      result.removed + result.closed > 0
        ? `took ${plural(result.removed + result.closed, 'empty departure')} off`
        : null,
      result.resized > 0 ? `updated capacity on ${plural(result.resized, 'departure')}` : null,
    ].filter(Boolean);

    const timeCount = liveRows.size;
    return {
      ok: true,
      message:
        bits.length > 0
          ? `Saved “${name}”. This ${bits.join(', ')} across the next 60 days.`
          : `Saved “${name}”. ${plural(timeCount, 'time')} on the template; the calendar already matched.`,
    };
  } catch (err) {
    if (err instanceof ScheduleRuleError) return { ok: false, message: err.message };
    throw err;
  }
}
