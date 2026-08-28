import { AdminShell, PageHeader } from '../../components/shell';
import { ManifestViews } from '../../components/manifest/ManifestViews';
import { ManifestUtilization } from '../../components/manifest/ManifestUtilization';
import { GuideScheduler } from '../../components/manifest/GuideScheduler';
import { DateNav } from '../../components/manifest/DateNav';
import { loadManifest, loadGuideRoster } from './data';
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

  const { rows, totalBookings, checkedIn, capacityTotal, capacityBooked } =
    await loadManifest(isoDate);
  const roster = await loadGuideRoster();
  const label = formatShortDate(`${isoDate}T12:00:00`);
  const utilizationPct =
    capacityTotal > 0 ? Math.round((capacityBooked / capacityTotal) * 100) : 0;

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
        <SummaryChip
          label="Utilization"
          value={`${capacityBooked}/${capacityTotal} · ${utilizationPct}%`}
          tone={utilizationPct >= 80 ? 'emerald' : 'slate'}
        />
      </div>

      <ManifestUtilization rows={rows} />

      <GuideScheduler rows={rows} roster={roster} />

      <ManifestViews rows={rows} />

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
  // The label used to be `opacity-70` over the tone colour, which composites to
  // #707a88 on white — 4.34:1, under the floor. Opacity on text is the trap here:
  // the colour that ships is not the colour in the class, so nothing in the source
  // looks wrong. De-emphasis now comes from size and weight, and the label carries a
  // real, measurable colour. (1.4.3)
  const labelClass = tone === 'emerald' ? 'text-emerald-800' : 'text-slate-600';
  return (
    <div className={`rounded-lg border px-4 py-2 shadow-sm ${toneClass}`}>
      <div className={`text-xs font-medium ${labelClass}`}>{label}</div>
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
    // slate-600/700, not slate-500/600: the legend sits on the page background
    // (bg-slate-100), where slate-500 is only 4.34:1. (1.4.3)
    <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-slate-600">
      <span className="font-medium text-slate-700">Capacity:</span>
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
