import { AdminShell, PageHeader } from '../../components/shell';
import { GanttManifest } from '../../components/manifest/GanttManifest';
import { DateNav } from '../../components/manifest/DateNav';
import { loadManifest } from '../manifest/data';
import { getOperatorContext, getTenantDb } from '../../lib/session';
import { normalizeIsoDate } from '../../components/manifest/tz';
import { formatShortDate } from '../../lib/format';

export const dynamic = 'force-dynamic';

interface SchedulePageProps {
  searchParams: { date?: string };
}

/**
 * Schedule — the fleet availability board, promoted to its own top-level screen
 * (it used to be a sub-tab inside the Manifest). Every boat is a row, time runs
 * left to right, and each departure shows as booked / open-to-sell / closed, so a
 * dispatcher reads the whole day's availability in one glance — the FareHarbor
 * resource view. Day-scoped via `?date=YYYY-MM-DD`, defaulting to operator-local
 * today. Reuses the manifest day-model loader (loadManifest) and the GanttManifest
 * board, so the data and the Day manifest never disagree.
 */
export default async function SchedulePage({ searchParams }: SchedulePageProps) {
  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();
  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { timezone: true },
  });
  const timeZone = operator?.timezone ?? 'America/Los_Angeles';
  const isoDate = normalizeIsoDate(searchParams.date, timeZone);
  const label = formatShortDate(`${isoDate}T12:00:00`);

  const { rows } = await loadManifest(isoDate);
  // The board shows live bookings; cancelled ones live on the order pages.
  const liveRows = rows.map((row) => ({
    ...row,
    bookings: row.bookings.filter((b) => b.status !== 'CANCELLED'),
  }));

  return (
    <AdminShell>
      <PageHeader
        title="Schedule"
        description="Every boat, all day — see at a glance what's booked, what's still open to sell, and what's out of service."
        actions={<DateNav date={isoDate} stepDays={1} label={label} />}
      />
      <GanttManifest rows={liveRows} isoDate={isoDate} timeZone={timeZone} />
    </AdminShell>
  );
}
