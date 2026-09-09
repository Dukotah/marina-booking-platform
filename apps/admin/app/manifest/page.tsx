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
import { customerWebBaseUrl } from '../../lib/customer-web';

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

  const { rows } = await loadManifest(isoDate);
  const roster = await loadGuideRoster();
  const fleet = await loadFleetRows(db);
  // `operator:manage` is the bar the settings screen sets on this same write, so the
  // manifest holds it too rather than inventing a looser one — and staff who cannot
  // commit the change are shown the fleet read-only instead of a dead button.
  const permissions = await currentPermissions();
  const canManageFleet = permissions.has('operator:manage');
  const label = formatShortDate(`${isoDate}T12:00:00`);

  return (
    <AdminShell>
      <PageHeader
        title="Manifest"
        description="Run the dock — check guests in, mark returns, and charge fuel or extras to a booking when the boat comes back."
        actions={<DateNav date={isoDate} stepDays={1} label={label} />}
      />

      {/* The day's departures + per-booking ops (check-in, returns, fuel/charges) —
          the real work of the manifest. The summary counts live inside ManifestViews
          now, where they double as one-tap filters; capacity/utilization detail
          stayed with the Day view's departure cards. */}
      <ManifestViews
        rows={rows}
        timeZone={timeZone}
        isoDate={isoDate}
        signLinkBase={customerWebBaseUrl()}
      />

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

