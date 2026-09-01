import { AdminShell, PageHeader } from '../../components/shell';
import { ManifestViews } from '../../components/manifest/ManifestViews';
import { GuideScheduler } from '../../components/manifest/GuideScheduler';
import { DateNav } from '../../components/manifest/DateNav';
import {
  FleetStatus,
  type FleetDownNote,
  type FleetResourceRow,
} from '../../components/manifest/FleetStatus';
import { loadManifest, loadGuideRoster } from './data';
import { currentPermissions, getOperatorContext, getTenantDb } from '../../lib/session';
import { normalizeIsoDate, todayIsoIn } from '../../components/manifest/tz';
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
  const fleet = await loadFleetRows(db);
  // `operator:manage` is the bar the settings screen sets on this same write, so the
  // manifest holds it too rather than inventing a looser one — and staff who cannot
  // commit the change are shown the fleet read-only instead of a dead button.
  const permissions = await currentPermissions();
  const canManageFleet = permissions.has('operator:manage');
  const label = formatShortDate(`${isoDate}T12:00:00`);
  const utilizationPct =
    capacityTotal > 0 ? Math.round((capacityBooked / capacityTotal) * 100) : 0;

  return (
    <AdminShell>
      <PageHeader
        title="Manifest"
        description="Run the dock — check guests in, mark returns, and charge fuel or extras to a booking when the boat comes back."
        actions={<DateNav date={isoDate} stepDays={1} label={label} />}
      />

      <div className="mb-5 flex flex-wrap gap-3">
        <SummaryChip label="Bookings" value={String(totalBookings)} />
        <SummaryChip
          label="Checked in"
          value={`${checkedIn}/${totalBookings}`}
          tone={checkedIn > 0 ? 'emerald' : 'slate'}
        />
        <SummaryChip label="Activities" value={String(rows.length)} />
        <SummaryChip
          label="Capacity"
          value={`${capacityBooked}/${capacityTotal} · ${utilizationPct}%`}
          tone={utilizationPct >= 80 ? 'emerald' : 'slate'}
        />
      </div>

      {/* The day's departures + per-booking ops (check-in, returns, fuel/charges) —
          the real work of the manifest. Utilization is now a summary chip above,
          not the hero it used to be. */}
      <ManifestViews rows={rows} timeZone={timeZone} isoDate={isoDate} />

      <Legend />

      {/* Secondary day-of ops, kept but demoted below the schedule. */}
      <div className="mt-8 space-y-6">
        <FleetStatus
          resources={fleet}
          canManage={canManageFleet}
          defaultFromISO={isoDate}
          todayISO={todayIsoIn(timeZone)}
        />
        <GuideScheduler rows={rows} roster={roster} />
      </div>
    </AdminShell>
  );
}

/**
 * The fleet as the dock needs it: each shared-resource pool, how much of it is on the
 * water, and — for anything currently down — the reason and dates last recorded.
 *
 * The reason and dates live in the audit log rather than on Resource (there is no
 * column for them; see the fleet section of ./actions.ts), so this reads the most
 * recent fleet event per pool and uses it only when the pool is in fact still down.
 * If the numbers and the note ever disagree, the numbers win: `out_of_service_qty` is
 * what the booking engine actually enforces.
 */
async function loadFleetRows(
  db: Awaited<ReturnType<typeof getTenantDb>>,
): Promise<FleetResourceRow[]> {
  const resources = await db.resource.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      quantity: true,
      seat_capacity: true,
      out_of_service_qty: true,
      is_active: true,
      activities: { select: { name_internal: true, name_external: true } },
    },
  });

  const downIds = resources.filter((r) => r.out_of_service_qty > 0).map((r) => r.id);
  const notes = new Map<string, FleetDownNote>();

  if (downIds.length > 0) {
    const events = await db.auditLog.findMany({
      where: {
        entity_type: 'Resource',
        entity_id: { in: downIds },
        action: { in: ['resource.out_of_service', 'resource.in_service'] },
      },
      orderBy: { created_at: 'desc' },
      select: { entity_id: true, action: true, after: true, created_at: true },
      // Newest-first with a ceiling: we only want the latest event per pool, and a
      // long-running marina should not pay for a season of history to find it.
      take: Math.max(50, downIds.length * 10),
    });

    for (const event of events) {
      // First row seen for a pool is its latest, because the list is newest-first.
      if (notes.has(event.entity_id)) continue;
      if (event.action !== 'resource.out_of_service') {
        // Latest event put it BACK, so the current downtime came from somewhere else
        // (settings, most likely) and we have no note to show. Mark it seen so an
        // older, stale reason cannot be dredged up and presented as current.
        notes.set(event.entity_id, { reason: '', fromISO: null, untilISO: null, recordedAtISO: '' });
        continue;
      }
      const after = (event.after ?? {}) as Record<string, unknown>;
      const reason = typeof after.reason === 'string' ? after.reason : '';
      if (!reason) continue;
      notes.set(event.entity_id, {
        reason,
        fromISO: typeof after.out_from === 'string' ? after.out_from : null,
        untilISO: typeof after.expected_back === 'string' ? after.expected_back : null,
        recordedAtISO: event.created_at.toISOString(),
      });
    }
  }

  return resources.map((r) => {
    const note = notes.get(r.id);
    return {
      id: r.id,
      name: r.name,
      quantity: r.quantity,
      seatCapacity: r.seat_capacity,
      outOfServiceQty: r.out_of_service_qty,
      isActive: r.is_active,
      activityNames: r.activities.map((a) => a.name_internal || a.name_external),
      down: note && note.reason ? note : null,
    };
  });
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
