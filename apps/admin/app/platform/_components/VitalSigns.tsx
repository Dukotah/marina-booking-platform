import { AlertTriangle, CalendarClock, Clock, DollarSign, Ticket } from 'lucide-react';
import { formatDate, formatNumber, formatRelative, formatUSD } from '../../../lib/format';
import { StatCard } from '../../../components/ui';
import type { CockpitVitals } from './cockpit-data';

/**
 * Is this client actually using the product?
 *
 * A rollout can look finished on the checklist and still be dead: the account is
 * configured, and nobody has taken a booking in a month. These four numbers are the
 * pulse, and the quiet-since warning is the churn signal the owner would otherwise
 * only notice at renewal.
 */

/** Past this many days with no booking, a live client is drifting. */
const QUIET_DAYS = 21;

export function VitalSigns({ vitals, isLive }: { vitals: CockpitVitals; isLive: boolean }) {
  const quiet =
    isLive && (vitals.daysSinceLastOrder === null || vitals.daysSinceLastOrder >= QUIET_DAYS);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Ticket}
          label="Activities"
          value={formatNumber(vitals.activeActivities)}
          hint={
            vitals.totalActivities > vitals.activeActivities
              ? `${formatNumber(vitals.totalActivities - vitals.activeActivities)} inactive`
              : 'all active'
          }
        />
        <StatCard
          icon={CalendarClock}
          label="Seats booked ahead"
          value={formatNumber(vitals.upcomingSeats)}
          hint={
            vitals.nextDepartureAt
              ? `next ${formatDate(vitals.nextDepartureAt)}`
              : 'nothing on the books'
          }
        />
        <StatCard
          icon={DollarSign}
          label="Revenue collected"
          value={formatUSD(vitals.revenueCents)}
          hint={`${formatUSD(vitals.revenueLast30Cents)} in 30 days · ${formatNumber(
            vitals.ordersAllTime,
          )} orders all time`}
        />
        <StatCard
          icon={Clock}
          label="Last booking taken"
          value={vitals.lastOrderAt ? formatRelative(vitals.lastOrderAt) : 'Never'}
          hint={`${formatNumber(vitals.orders30d)} orders in 30 days · ${formatNumber(
            vitals.customerCount,
          )} customers`}
        />
      </div>

      {quiet && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
          <span>
            {vitals.daysSinceLastOrder === null
              ? 'This client is marked live but has never taken a booking. Worth a call.'
              : `No booking taken in ${formatNumber(vitals.daysSinceLastOrder)} days. That is the shape of a client about to churn — worth a call.`}
          </span>
        </p>
      )}
    </div>
  );
}
