import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { AdminShell, PageHeader } from '../../../components/shell';
import { ActivityWizard } from '../../../components/activities/ActivityWizard';
import {
  ScheduleEditor,
  type ClosedDay,
  type ScheduleDefaults,
  type ScheduleSnapshot,
} from '../../../components/activities/ScheduleEditor';
import {
  RuleScheduler,
  type BlackoutGroupView,
  type CopyOption,
} from '../../../components/activities/RuleScheduler';
import type { RuleView } from '../schedule-rules-actions';
import { addIsoDays, localDayRangeUtc, toLocalParts, todayIsoIn } from '../../../components/manifest/tz';
import { loadActivityForm, loadLocationOptions } from '../loaders';
import { getTenantDb, requirePermission } from '../../../lib/session';
import type { ScheduleFormValues } from '../../../components/activities/types';

export const dynamic = 'force-dynamic';

/** How far ahead the "what is on the calendar now" summary looks. */
const LOOKAHEAD_DAYS = 400;

/** The default stretch of dates the hours form opens on — roughly a season. */
const DEFAULT_RANGE_DAYS = 90;

/** Closed days listed individually before the list would take over the page. */
const CLOSED_DAY_LIMIT = 30;

/**
 * What the activity's timeslots actually say, day by day, from today forward.
 *
 * This is deliberately measured from the rows in the table rather than read back out
 * of `Activity.config`: config is what somebody typed into the create wizard once,
 * and after the first schedule edit the two can disagree. The operator is shown the
 * calendar, not the setting.
 */
async function loadScheduleSnapshot(
  activityId: string,
  fallback: ScheduleFormValues,
): Promise<{ snapshot: ScheduleSnapshot; defaults: ScheduleDefaults } | null> {
  const db = await getTenantDb();

  const activity = await db.activity.findUnique({
    where: { id: activityId },
    select: {
      location: { select: { timezone: true } },
      operator: { select: { timezone: true } },
    },
  });
  if (!activity) return null;

  const timezone = activity.location?.timezone ?? activity.operator.timezone;
  const today = todayIsoIn(timezone);
  const startUtc = localDayRangeUtc(today, timezone).startUtc;
  const endUtc = localDayRangeUtc(addIsoDays(today, LOOKAHEAD_DAYS), timezone).endUtc;

  const slots = await db.timeslot.findMany({
    where: { activity_id: activityId, datetime: { gte: startUtc, lt: endUtc } },
    select: {
      datetime: true,
      status: true,
      capacity_total: true,
      capacity_booked: true,
    },
    orderBy: { datetime: 'asc' },
  });

  interface DayRoll {
    openMinutes: number[];
    closedCount: number;
    booked: number;
  }
  const byDay = new Map<string, DayRoll>();
  const capacityTally = new Map<number, number>();

  for (const slot of slots) {
    const parts = toLocalParts(slot.datetime, timezone);
    const iso = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    let day = byDay.get(iso);
    if (!day) {
      day = { openMinutes: [], closedCount: 0, booked: 0 };
      byDay.set(iso, day);
    }
    if (slot.status === 'CANCELLED') {
      day.closedCount += 1;
      continue;
    }
    day.openMinutes.push(parts.hour * 60 + parts.minute);
    day.booked += slot.capacity_booked;
    capacityTally.set(slot.capacity_total, (capacityTally.get(slot.capacity_total) ?? 0) + 1);
  }

  const openDays = [...byDay.entries()]
    .filter(([, day]) => day.openMinutes.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1));

  const closedDays: ClosedDay[] = [...byDay.entries()]
    .filter(([, day]) => day.openMinutes.length === 0 && day.closedCount > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(0, CLOSED_DAY_LIMIT)
    .map(([date, day]) => ({ date, timeCount: day.closedCount }));

  const weekdays = new Set<number>();
  const startMinutes = new Set<number>();
  let timeCount = 0;
  let bookedDayCount = 0;
  for (const [iso, day] of openDays) {
    const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
    weekdays.add(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
    for (const minutes of day.openMinutes) startMinutes.add(minutes);
    timeCount += day.openMinutes.length;
    if (day.booked > 0) bookedDayCount += 1;
  }

  const snapshot: ScheduleSnapshot = {
    timezone,
    today,
    firstDate: openDays[0]?.[0] ?? null,
    lastDate: openDays[openDays.length - 1]?.[0] ?? null,
    dayCount: openDays.length,
    timeCount,
    bookedDayCount,
    weekdays: [...weekdays].sort((a, b) => a - b),
    startMinutes: [...startMinutes].sort((a, b) => a - b),
    closedDays,
  };

  // Open the form on what this activity already does, so the common edit — same
  // hours, new stretch of dates — is a two-field change rather than a re-entry.
  const sortedStarts = snapshot.startMinutes;
  const interval = mostCommonGap(openDays.map(([, day]) => day.openMinutes));
  const capacity = mostCommon([...capacityTally.entries()]);

  const defaults: ScheduleDefaults = {
    openHour: sortedStarts.length > 0 ? Math.floor(sortedStarts[0] / 60) : fallback.open_hour,
    closeHour:
      sortedStarts.length > 0
        ? Math.min(
            24,
            Math.max(
              Math.floor(sortedStarts[0] / 60) + 1,
              Math.ceil((sortedStarts[sortedStarts.length - 1] + (interval ?? 60)) / 60),
            ),
          )
        : fallback.close_hour,
    intervalMinutes: interval ?? fallback.interval_minutes,
    capacityPerSlot: capacity ?? fallback.capacity_total,
    weekdays: snapshot.weekdays.length > 0 ? snapshot.weekdays : [0, 1, 2, 3, 4, 5, 6],
    startDate: today,
    endDate: addIsoDays(today, DEFAULT_RANGE_DAYS - 1),
  };

  return { snapshot, defaults };
}

/** The gap that shows up most often between one day's start times, in minutes. */
function mostCommonGap(days: number[][]): number | null {
  const tally = new Map<number, number>();
  for (const minutes of days) {
    const sorted = [...new Set(minutes)].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      const gap = sorted[i] - sorted[i - 1];
      tally.set(gap, (tally.get(gap) ?? 0) + 1);
    }
  }
  return mostCommon([...tally.entries()]);
}

/** The value with the highest count; ties break to the smaller value for stability. */
function mostCommon(entries: Array<[number, number]>): number | null {
  let best: number | null = null;
  let bestCount = 0;
  for (const [value, count] of entries) {
    if (count > bestCount || (count === bestCount && best !== null && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** Data the repeating-schedule builder needs: rules, closed dates, copy sources. */
async function loadRuleSchedulerData(activityId: string): Promise<{
  boatCapacity: number;
  today: string;
  rules: RuleView[];
  blackouts: BlackoutGroupView[];
  copyOptions: CopyOption[];
} | null> {
  const db = await getTenantDb();
  const activity = await db.activity.findUnique({
    where: { id: activityId },
    select: {
      max_participants: true,
      location_id: true,
      location: { select: { timezone: true } },
      operator: { select: { timezone: true } },
    },
  });
  if (!activity) return null;

  const timezone = activity.location?.timezone ?? activity.operator.timezone;
  const today = todayIsoIn(timezone);

  const [ruleRows, blackoutRows, ruleCounts, otherActivities] = await Promise.all([
    db.scheduleRule.findMany({
      where: { activity_id: activityId },
      orderBy: { created_at: 'asc' },
    }),
    db.blackoutDate.findMany({
      where: {
        date: { gte: new Date(`${today}T00:00:00.000Z`) },
        OR: [
          { activity_id: activityId },
          {
            activity_id: null,
            ...(activity.location_id
              ? { OR: [{ location_id: null }, { location_id: activity.location_id }] }
              : { location_id: null }),
          },
        ],
      },
      orderBy: { date: 'asc' },
    }),
    db.scheduleRule.groupBy({ by: ['activity_id'], _count: { _all: true } }),
    db.activity.findMany({
      where: { id: { not: activityId } },
      select: { id: true, name_internal: true },
      orderBy: { sort_index: 'asc' },
    }),
  ]);

  // Group consecutive closed days sharing a scope + reason into one line.
  const blackouts: BlackoutGroupView[] = [];
  for (const row of blackoutRows) {
    const date = row.date.toISOString().slice(0, 10);
    const scope: BlackoutGroupView['scope'] = row.activity_id ? 'activity' : 'operator';
    const last = blackouts[blackouts.length - 1];
    if (
      last &&
      last.scope === scope &&
      last.reason === row.reason &&
      addIsoDays(last.endDate, 1) === date
    ) {
      last.endDate = date;
      last.ids.push(row.id);
    } else {
      blackouts.push({ ids: [row.id], startDate: date, endDate: date, reason: row.reason, scope });
    }
  }

  const counts = new Map(ruleCounts.map((r) => [r.activity_id, r._count._all]));
  const copyOptions: CopyOption[] = otherActivities
    .map((a) => ({ id: a.id, name: a.name_internal, ruleCount: counts.get(a.id) ?? 0 }))
    .filter((a) => a.ruleCount > 0);

  return {
    boatCapacity: activity.max_participants,
    today,
    rules: ruleRows.map((r) => ({
      id: r.id,
      name: r.name,
      startDate: r.start_date,
      endDate: r.end_date,
      weekdays: r.weekdays,
      startMinutes: r.start_minutes,
      capacity: r.capacity,
      isActive: r.is_active,
    })),
    blackouts,
    copyOptions,
  };
}

/**
 * Edit an existing activity. The 4-step wizard covers details and rates; below it
 * the repeating-schedule builder (rules that keep the calendar filled) and the
 * day-by-day editor (one-off changes to a stretch of dates). Gated by
 * `activity:write`.
 */
export default async function EditActivityPage({ params }: { params: { id: string } }) {
  await requirePermission('activity:write');

  const [defaultValues, locations] = await Promise.all([
    loadActivityForm(params.id),
    loadLocationOptions(),
  ]);

  if (!defaultValues) {
    notFound();
  }

  const [schedule, ruleData] = await Promise.all([
    loadScheduleSnapshot(params.id, defaultValues.schedule),
    loadRuleSchedulerData(params.id),
  ]);

  return (
    <AdminShell>
      <PageHeader
        title={defaultValues.name_external || 'Edit activity'}
        description="Update details, rates, and scheduling."
        actions={
          <Link
            href="/activities"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            Back to activities
          </Link>
        }
      />

      <div className="space-y-8">
        <ActivityWizard
          mode="edit"
          activityId={params.id}
          defaultValues={defaultValues}
          locations={locations}
        />

        {ruleData ? <RuleScheduler activityId={params.id} {...ruleData} /> : null}

        {schedule ? (
          <ScheduleEditor
            activityId={params.id}
            snapshot={schedule.snapshot}
            defaults={schedule.defaults}
          />
        ) : null}
      </div>
    </AdminShell>
  );
}
