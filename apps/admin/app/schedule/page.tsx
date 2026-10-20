import Link from 'next/link';
import { AdminShell, PageHeader } from '../../components/shell';
import { GanttManifest } from '../../components/manifest/GanttManifest';
import { DateNav } from '../../components/manifest/DateNav';
import { loadManifest } from '../manifest/data';
import { getOperatorContext, getTenantDb } from '../../lib/session';
import { normalizeIsoDate } from '../../components/manifest/tz';
import { formatShortDate, formatUSD } from '../../lib/format';
import { cn } from '../../lib/cn';
import {
  ScheduleTemplateGrid,
  type TemplateRow,
} from '../../components/schedule/ScheduleTemplateGrid';
import { ActivitySwitcher } from '../../components/schedule/ActivitySwitcher';

export const dynamic = 'force-dynamic';

type Tab = 'design' | 'availability';

interface SchedulePageProps {
  searchParams: { date?: string; tab?: string; activity?: string };
}

/**
 * Schedule — now two views behind tabs:
 *   • Design (default): the weekly Schedule Template Designer, a per-activity
 *     grid of departure times × weekdays, a faithful replica of Singenuity's
 *     "Schedule Template → Times" screen. Projects + reconciles ScheduleRules.
 *   • Availability: the existing read-only fleet board (GanttManifest), moved
 *     here UNCHANGED — every boat a row, time left-to-right, booked/open/closed.
 *
 * Tab + activity are URL-driven (?tab=, ?activity=); the board keeps ?date=.
 */
export default async function SchedulePage({ searchParams }: SchedulePageProps) {
  const tab: Tab = searchParams.tab === 'availability' ? 'availability' : 'design';

  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();
  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { timezone: true },
  });
  const timeZone = operator?.timezone ?? 'America/Los_Angeles';

  return (
    <AdminShell>
      <PageHeader
        title="Schedule"
        description="Design each boat's weekly template, or read the whole fleet's day at a glance."
      />

      <nav className="mb-6 border-b border-line" aria-label="Schedule views">
        <div className="flex gap-6">
          <TabLink tab="design" current={tab} label="Design" />
          <TabLink tab="availability" current={tab} label="Availability" />
        </div>
      </nav>

      {tab === 'availability' ? (
        <AvailabilityView date={searchParams.date} timeZone={timeZone} />
      ) : (
        <DesignView activityId={searchParams.activity} timeZone={timeZone} />
      )}
    </AdminShell>
  );
}

function TabLink({ tab, current, label }: { tab: Tab; current: Tab; label: string }) {
  const active = tab === current;
  return (
    <Link
      href={`/schedule?tab=${tab}`}
      aria-current={active ? 'page' : undefined}
      className={cn(
        '-mb-px border-b-2 px-1 py-2.5 text-sm font-medium transition-colors',
        active ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink-body',
      )}
    >
      {label}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Availability — the existing board, unchanged.
// ---------------------------------------------------------------------------

async function AvailabilityView({ date, timeZone }: { date?: string; timeZone: string }) {
  const isoDate = normalizeIsoDate(date, timeZone);
  const label = formatShortDate(`${isoDate}T12:00:00`);
  const { rows } = await loadManifest(isoDate);
  // The board shows live bookings; cancelled ones live on the order pages.
  const liveRows = rows.map((row) => ({
    ...row,
    bookings: row.bookings.filter((b) => b.status !== 'CANCELLED'),
  }));

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <DateNav date={isoDate} stepDays={1} label={label} />
      </div>
      <GanttManifest rows={liveRows} isoDate={isoDate} timeZone={timeZone} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Design — the template grid designer.
// ---------------------------------------------------------------------------

async function DesignView({ activityId, timeZone }: { activityId?: string; timeZone: string }) {
  const db = await getTenantDb();

  const activities = await db.activity.findMany({
    where: { status: 'ACTIVE' },
    orderBy: [{ sort_index: 'asc' }, { name_internal: 'asc' }],
    select: { id: true, name_internal: true, name_external: true, max_participants: true },
  });

  if (activities.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-surface-muted/40 p-10 text-center">
        <p className="text-sm font-medium text-ink">No active boats or listings yet.</p>
        <p className="mt-1 text-sm text-ink-muted">
          Add one in Catalog, then design its weekly schedule template here.
        </p>
      </div>
    );
  }

  const selected = activities.find((a) => a.id === activityId) ?? activities[0];

  // Rates → price range. Rules → the grid rows.
  const [rates, rules] = await Promise.all([
    db.rate.findMany({
      where: { activity_id: selected.id, is_active: true },
      select: { price_cents: true },
    }),
    db.scheduleRule.findMany({
      where: { activity_id: selected.id },
      orderBy: { created_at: 'asc' },
      select: { name: true, start_date: true, end_date: true, weekdays: true, start_minutes: true, capacity: true },
    }),
  ]);

  const prices = rates.map((r) => r.price_cents);
  const priceRange =
    prices.length > 0
      ? { minCents: Math.min(...prices), maxCents: Math.max(...prices) }
      : null;
  const priceLabel = priceRange
    ? priceRange.minCents === priceRange.maxCents
      ? formatUSD(priceRange.minCents)
      : `${formatUSD(priceRange.minCents)} - ${formatUSD(priceRange.maxCents)}`
    : null;

  // Expand the DEPARTURE rules (fixed start_minutes) into one grid row per
  // distinct minute. A (time, weekday) cell is ON when some rule includes both;
  // the cell's capacity is that rule's capacity (rows merge by minute, last rule
  // wins the capacity — the designer edits capacity per-row anyway).
  const rowByMinute = new Map<number, TemplateRow>();
  let templateName = '';
  let startDate = '';
  let endDate = '';
  for (const rule of rules) {
    if (rule.start_minutes.length === 0) continue; // skip rental-window rules
    if (!templateName) {
      templateName = rule.name;
      startDate = rule.start_date;
      endDate = rule.end_date;
    }
    for (const minute of rule.start_minutes) {
      const existing = rowByMinute.get(minute);
      if (existing) {
        existing.weekdays = [...new Set([...existing.weekdays, ...rule.weekdays])].sort((a, b) => a - b);
        existing.capacity = rule.capacity ?? existing.capacity;
      } else {
        rowByMinute.set(minute, {
          minute,
          weekdays: [...rule.weekdays].sort((a, b) => a - b),
          capacity: rule.capacity,
        });
      }
    }
  }
  const rows = [...rowByMinute.values()].sort((a, b) => a.minute - b.minute);

  // Default season bounds when the boat has no departure template yet: today
  // through ~120 days out, in the operator's timezone.
  if (!startDate) {
    const todayIso = normalizeIsoDate(undefined, timeZone);
    startDate = todayIso;
    endDate = addDays(todayIso, 120);
  }

  const activityName = selected.name_internal || selected.name_external;

  return (
    <div className="space-y-6">
      <ActivitySwitcher
        activities={activities.map((a) => ({
          id: a.id,
          name: a.name_internal || a.name_external,
        }))}
        selectedId={selected.id}
      />
      <ScheduleTemplateGrid
        key={selected.id}
        activityId={selected.id}
        activityName={activityName}
        templateName={templateName}
        startDate={startDate}
        endDate={endDate}
        rows={rows}
        priceRange={priceRange}
        priceLabel={priceLabel}
        defaultCapacity={selected.max_participants}
      />
    </div>
  );
}

/** Add days to a YYYY-MM-DD string (UTC math — day arithmetic, no tz shift). */
function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
