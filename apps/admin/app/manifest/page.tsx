import { AdminShell, PageHeader } from '../../components/shell';
import { GanttManifest } from '../../components/manifest/GanttManifest';
import { DateNav } from '../../components/manifest/DateNav';
import { loadManifest } from './data';
import { getOperatorContext, getTenantDb } from '../../lib/session';
import { normalizeIsoDate } from '../../components/manifest/tz';
import { formatShortDate } from '../../lib/format';

export const dynamic = 'force-dynamic';

interface ManifestPageProps {
  searchParams: { date?: string };
}

/**
 * Day manifest — the visual, Gantt-style answer to Singenuity's text-wall manifest.
 * Rows are activities, the X axis is time, and bookings are color-coded blocks with a
 * one-click check-in. Date is driven by `?date=YYYY-MM-DD`, defaulting to today in the
 * operator's timezone.
 */
export default async function ManifestPage({ searchParams }: ManifestPageProps) {
  // Resolve the operator timezone first so "today" and day bounds are operator-local.
  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();
  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { timezone: true },
  });
  const timeZone = operator?.timezone ?? 'America/Los_Angeles';
  const isoDate = normalizeIsoDate(searchParams.date, timeZone);

  const { rows, totalBookings, checkedIn } = await loadManifest(isoDate);
  const label = formatShortDate(`${isoDate}T12:00:00`);

  return (
    <AdminShell>
      <PageHeader
        title="Manifest"
        description="Your whole day at a glance — color-coded by activity, with one-tap check-in."
        actions={<DateNav date={isoDate} stepDays={1} label={label} />}
      />

      <div className="mb-5 flex flex-wrap gap-3">
        <SummaryChip label="Activities" value={String(rows.length)} />
        <SummaryChip label="Bookings" value={String(totalBookings)} />
        <SummaryChip
          label="Checked in"
          value={`${checkedIn}/${totalBookings}`}
          tone={checkedIn > 0 ? 'emerald' : 'slate'}
        />
      </div>

      <GanttManifest rows={rows} />

      <Legend />
    </AdminShell>
  );
}

function SummaryChip({
  label,
  value,
  tone = 'slate',
}: {
  label: string;
  value: string;
  tone?: 'slate' | 'emerald';
}) {
  const toneClass =
    tone === 'emerald'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : 'border-slate-200 bg-white text-slate-700';
  return (
    <div className={`rounded-lg border px-4 py-2 shadow-sm ${toneClass}`}>
      <div className="text-xs font-medium opacity-70">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Legend() {
  const items = [
    { label: 'Available', className: 'bg-emerald-500' },
    { label: 'Filling up', className: 'bg-amber-500' },
    { label: 'Full', className: 'bg-rose-500' },
  ];
  return (
    <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-slate-500">
      <span className="font-medium text-slate-600">Capacity:</span>
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className={`h-2.5 w-2.5 rounded-full ${i.className}`} aria-hidden />
          {i.label}
        </span>
      ))}
      <span className="ml-auto inline-flex items-center gap-1.5">
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          ✓
        </span>
        Checked-in booking
      </span>
    </div>
  );
}
