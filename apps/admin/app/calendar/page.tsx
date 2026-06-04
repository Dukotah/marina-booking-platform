import { AdminShell, PageHeader } from '../../components/shell';
import { WeekCalendar } from '../../components/manifest/WeekCalendar';
import { DateNav } from '../../components/manifest/DateNav';
import { getOperatorContext, getTenantDb } from '../../lib/session';
import { normalizeIsoDate, weekStartIso, addIsoDays } from '../../components/manifest/tz';
import { loadWeek } from './data';
import { formatDate } from '../../lib/format';

export const dynamic = 'force-dynamic';

interface CalendarPageProps {
  searchParams: { date?: string };
}

/**
 * Week calendar — a real seven-column grid of bookings (not a flat strip). Each day
 * is a column over a shared time axis; bookings are color-coded blocks that deep-link
 * to their order. Navigation steps a week at a time via `?date=YYYY-MM-DD`.
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
  const startIso = weekStartIso(isoDate);
  const endIso = addIsoDays(startIso, 6);

  const { days, events, totalBookings } = await loadWeek(startIso);

  // "Jun 2 – 8, 2026" style range label.
  const label = formatWeekRange(startIso, endIso);

  return (
    <AdminShell>
      <PageHeader
        title="Calendar"
        description="A real week grid of every booking — color-coded by activity."
        actions={<DateNav date={isoDate} stepDays={7} label={label} />}
      />

      <div className="mb-5 flex flex-wrap gap-3">
        <SummaryChip label="This week" value={`${totalBookings} bookings`} />
      </div>

      <WeekCalendar days={days} events={events} />
    </AdminShell>
  );
}

function SummaryChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-2 shadow-sm">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-slate-800">{value}</div>
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
