import Link from 'next/link';
import { Plus } from 'lucide-react';
import { buttonClasses } from '../../components/ui';
import { AdminShell, PageHeader } from '../../components/shell';
import { ManifestViews } from '../../components/manifest/ManifestViews';
import { GuideScheduler } from '../../components/manifest/GuideScheduler';
import { DateNav } from '../../components/manifest/DateNav';
import { CollapsedSection } from '../../components/manifest/CollapsedSection';
import { FleetStatus } from '../../components/manifest/FleetStatus';
import { loadManifest, loadGuideRoster, loadFleetBoats } from './data';
import { currentPermissions, getOperatorContext, getTenantDb } from '../../lib/session';
import { normalizeIsoDate } from '../../components/manifest/tz';
import { formatShortDate } from '../../lib/format';

interface CommandCenterProps {
  /** Raw `?date=YYYY-MM-DD` from the route; undefined = today (operator-local). */
  date?: string;
  /**
   * When true, show the "Today · <date>" greeting header (the / home surface).
   * /manifest keeps its own "Manifest" PageHeader so deep links read as the
   * manifest, not the home page.
   */
  home?: boolean;
}

/**
 * The operational command center — the day manifest and its secondary day-of
 * surfaces (fleet, guides). Rendered from BOTH `/` (home, `home` on) and
 * `/manifest` (deep-linkable), so staff land directly on the work instead of a
 * BI dashboard. Date is driven by `?date=YYYY-MM-DD`, defaulting to today in the
 * operator's timezone.
 *
 * The page is the working list, full stop. Fleet and guide admin are real but
 * secondary day-of surfaces, so they render as one-line summaries that expand on
 * tap (CollapsedSection) instead of stacking two fully-expanded panels under the
 * schedule — that stack was the "scrolls forever" complaint.
 */
export async function CommandCenter({ date, home = false }: CommandCenterProps) {
  // Resolve the operator timezone first so "today" and day bounds are operator-local.
  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();
  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { timezone: true, name_internal: true },
  });
  const timeZone = operator?.timezone ?? 'America/Los_Angeles';
  const isoDate = normalizeIsoDate(date, timeZone);

  const { rows } = await loadManifest(isoDate);
  const roster = await loadGuideRoster();
  const fleet = await loadFleetBoats();
  // `operator:manage` is the bar the settings screen sets on capacity writes, so
  // the fleet panel holds it too rather than inventing a looser one — staff who
  // cannot commit the change see the fleet read-only instead of a dead button.
  const permissions = await currentPermissions();
  const canManageFleet = permissions.has('operator:manage');
  const label = formatShortDate(`${isoDate}T12:00:00`);

  // The one primary action for the command center: open the register prefilled to
  // today's catalog (the POS screen always loads the current day's slots). The ONE
  // teal accent in the admin's Clean SaaS system — everything else (DateNav) stays
  // neutral/hairline. Uses the shared Button look via buttonClasses so the primary
  // action is identical on every screen.
  const newBooking = (
    <Link href="/pos" className={buttonClasses('primary', 'md')}>
      <Plus className="h-4 w-4" aria-hidden />
      New booking
    </Link>
  );

  // The collapsed rows carry the one-glance numbers so nobody has to expand
  // them just to know whether anything needs attention.
  const down = fleet.boats.filter((b) => b.outage !== null).length;
  const onWater = fleet.boats.length - down;
  const fleetSummary =
    down === 0
      ? `All ${fleet.boats.length} on the water`
      : `${onWater} of ${fleet.boats.length} on the water · ${down} out of service`;

  const daySlots = rows.reduce((n, row) => n + row.slots.length, 0);
  const slotsWithGuide = rows.reduce(
    (n, row) => n + row.slots.filter((s) => s.guides.length > 0).length,
    0,
  );
  const guideSummary =
    daySlots === 0
      ? 'No departures today'
      : `${slotsWithGuide} of ${daySlots} departures have a guide`;

  return (
    <AdminShell>
      {home ? (
        <PageHeader
          title={`Today · ${label}`}
          description={
            operator?.name_internal
              ? `${operator.name_internal} — check guests in, mark returns, and charge fuel or extras to a booking when the boat comes back.`
              : 'Check guests in, mark returns, and charge fuel or extras to a booking when the boat comes back.'
          }
          actions={
            <>
              <DateNav date={isoDate} stepDays={1} label={label} />
              {newBooking}
            </>
          }
        />
      ) : (
        <PageHeader
          title="Manifest"
          description="Run the dock — check guests in, mark returns, and charge fuel or extras to a booking when the boat comes back."
          actions={<DateNav date={isoDate} stepDays={1} label={label} />}
        />
      )}

      {/* The day's departures — the real work of the manifest. Per-booking ops
          (check-in, returns, fuel/charges, waiver links) live in the reservation
          card each guest name opens. */}
      <ManifestViews rows={rows} timeZone={timeZone} isoDate={isoDate} />

      {/* Secondary day-of ops: collapsed to their headline numbers by default. */}
      <div className="mt-8 space-y-3">
        <CollapsedSection title="Fleet" summary={fleetSummary}>
          <FleetStatus
            boats={fleet.boats}
            canManage={canManageFleet}
            defaultFromISO={isoDate}
            todayISO={fleet.todayISO}
          />
        </CollapsedSection>

        <CollapsedSection title="Guides" summary={guideSummary}>
          <GuideScheduler rows={rows} roster={roster} />
        </CollapsedSection>
      </div>
    </AdminShell>
  );
}
