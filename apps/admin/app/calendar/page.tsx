import Link from 'next/link';
import { CalendarDays, CalendarRange } from 'lucide-react';
import { AdminShell, PageHeader } from '../../components/shell';
import { WeekCalendar } from '../../components/manifest/WeekCalendar';
import { DaySchedule } from '../../components/manifest/DaySchedule';
import { DateNav } from '../../components/manifest/DateNav';
import { getOperatorContext, getTenantDb } from '../../lib/session';
import { normalizeIsoDate, weekStartIso, addIsoDays } from '../../components/manifest/tz';
import { loadWeek } from './data';
import { loadManifest } from '../manifest/data';
import { formatDate, formatShortDate } from '../../lib/format';
import { cn } from '../../lib/cn';

export const dynamic = 'force-dynamic';

interface CalendarPageProps {
  searchParams: { date?: string; view?: string };
}

/**
 * Calendar — two coordinated views, matching how FareHarbor/Peek run a day:
 *   Day  → every timeslot for one day as a roomy, time-ordered card (the working view).
 *   Week → a seven-column grid for spatial overview.
 * The view is `?view=day|week`; date navigation preserves it. Week is the default so
 * "Calendar" stays the overview, with Day one tap away (and the Manifest is day-first).
 */
export default async function CalendarPage({ searchParams }: CalendarPageProps) {
  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();
  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { timezone: true },
  });
  const timeZone = operator?.timezone ?? 'America/Los_Angeles';

  const isoDate = normalizeIsoDate(searchParams.date, timeZone);
  const view = searchParams.view === 'day' ? 'day' : 'week';

  if (view === 'day') {
    const { rows } = await loadManifest(isoDate);
    const dayLabel = formatShortDate(`${isoDate}T12:00:00`); // "Thu, Aug 28"
    return (
      <AdminShell>
        <PageHeader
          title="Calendar"
          description="Every timeslot for the day, in order — the whole day at a glance."
          actions={<DateNav date={isoDate} stepDays={1} label={dayLabel} />}
        />
        <ViewToggle view="day" isoDate={isoDate} />
        <div className="mt-5">
          <DaySchedule rows={rows} timeZone={timeZone} isoDate={isoDate} showCheckIn={false} />
        </div>
      </AdminShell>
    );
  }

  const startIso = weekStartIso(isoDate);
  const endIso = addIsoDays(startIso, 6);
  const { days, events, totalBookings } = await loadWeek(startIso);
  const label = formatWeekRange(startIso, endIso);

  return (
    <AdminShell>
      <PageHeader
        title="Calendar"
        description="The week at a glance — every departure as a one-line chip, by day."
        actions={<DateNav date={isoDate} stepDays={7} label={label} />}
      />
      <ViewToggle view="week" isoDate={isoDate} />
      <p className="mt-4 text-sm text-slate-600">
        <span className="font-semibold tabular-nums text-slate-900">{totalBookings}</span>{' '}
        {totalBookings === 1 ? 'booking' : 'bookings'} this week
      </p>
      <div className="mt-2">
        <WeekCalendar days={days} events={events} />
      </div>
    </AdminShell>
  );
}

/** Day / Week tabs. Server-rendered links that preserve the selected date. */
function ViewToggle({ view, isoDate }: { view: 'day' | 'week'; isoDate: string }) {
  const base =
    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors';
  return (
    <div
      role="group"
      aria-label="Calendar view"
      className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm"
    >
      <Link
        href={`/calendar?view=day&date=${isoDate}`}
        aria-current={view === 'day' ? 'page' : undefined}
        className={cn(base, view === 'day' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100')}
      >
        <CalendarDays className="h-4 w-4" aria-hidden /> Day
      </Link>
      <Link
        href={`/calendar?view=week&date=${isoDate}`}
        aria-current={view === 'week' ? 'page' : undefined}
        className={cn(base, view === 'week' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100')}
      >
        <CalendarRange className="h-4 w-4" aria-hidden /> Week
      </Link>
    </div>
  );
}

/** "Jun 2 – 8, 2026" — collapses month/year when shared across the range. */
function formatWeekRange(startIso: string, endIso: string): string {
  const start = formatDate(`${startIso}T12:00:00`); // "Jun 2, 2026"
  const end = formatDate(`${endIso}T12:00:00`); // "Jun 8, 2026"
  const [startMonthDay] = start.split(',');
  const [endMonthDay, endYear] = end.split(',');
  const startMonth = startMonthDay.split(' ')[0];
  const endMonth = endMonthDay.trim().split(' ')[0];
  if (startMonth === endMonth) {
    const startDay = startMonthDay.split(' ')[1];
    const endDay = endMonthDay.trim().split(' ')[1];
    return `${startMonth} ${startDay} – ${endDay},${endYear}`;
  }
  return `${startMonthDay} – ${endMonthDay.trim()},${endYear}`;
}
