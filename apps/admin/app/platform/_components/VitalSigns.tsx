import {
  AlertTriangle,
  CalendarClock,
  Clock,
  DollarSign,
  Ticket,
  type LucideIcon,
} from 'lucide-react';
import { formatDate, formatNumber, formatRelative, formatUSD } from '../../../lib/format';
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
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon={Ticket}
          label="Activities"
          value={formatNumber(vitals.activeActivities)}
          sub={
            vitals.totalActivities > vitals.activeActivities
              ? `${formatNumber(vitals.totalActivities - vitals.activeActivities)} inactive`
              : 'all active'
          }
        />
        <Stat
          icon={CalendarClock}
          label="Seats booked ahead"
          value={formatNumber(vitals.upcomingSeats)}
          sub={
            vitals.nextDepartureAt
              ? `next ${formatDate(vitals.nextDepartureAt)}`
              : 'nothing on the books'
          }
        />
        <Stat
          icon={DollarSign}
          label="Revenue collected"
          value={formatUSD(vitals.revenueCents)}
          sub={`${formatUSD(vitals.revenueLast30Cents)} in 30 days · ${formatNumber(
            vitals.ordersAllTime,
          )} orders all time`}
        />
        <Stat
          icon={Clock}
          label="Last booking taken"
          value={vitals.lastOrderAt ? formatRelative(vitals.lastOrderAt) : 'Never'}
          sub={`${formatNumber(vitals.orders30d)} orders in 30 days · ${formatNumber(
            vitals.customerCount,
          )} customers`}
        />
      </dl>

      {quiet && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
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

function Stat({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label}
      </dt>
      <dd className="mt-1.5">
        <span className="block text-xl font-semibold tabular-nums text-slate-100">{value}</span>
        <span className="mt-0.5 block text-xs text-slate-400">{sub}</span>
      </dd>
    </div>
  );
}
