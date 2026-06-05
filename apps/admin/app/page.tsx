// Operator dashboard home — the "dashboard-first" answer to Singenuity dumping
// operators into a raw text manifest. Revenue, occupancy, alerts, and the next
// bookings, all at a glance. Every figure is computed from real, tenant-scoped
// queries (RLS-enforced); empty data degrades gracefully (no seed required).

import { CalendarClock, DollarSign, Gauge, TrendingUp } from 'lucide-react';
import { StatCard } from '@marina/ui';
import { AdminShell } from '../components/shell/AdminShell';
import { PageHeader } from '../components/shell/PageHeader';
import {
  AlertsList,
  OccupancySnapshot,
  RevenueTrendChart,
  SectionCard,
  UpcomingBookings,
  getDashboardData,
} from '../components/dashboard';
import { getOperatorContext, getTenantDb } from '../lib/session';
import { formatNumber, formatPercent, formatUSD } from '../lib/format';

// KPIs reflect live data; never cache stale figures for an operations dashboard.
export const dynamic = 'force-dynamic';

/** Resolve the operator's brand color so the trend chart stays white-label. */
async function getBrandColor(): Promise<string> {
  const fallback = '#0ea5e9';
  try {
    const { operatorId } = await getOperatorContext();
    const db = await getTenantDb();
    const operator = await db.operator.findUnique({
      where: { id: operatorId },
      select: { brand_color: true },
    });
    return operator?.brand_color || fallback;
  } catch {
    // DB unreachable — getDashboardData surfaces the notice; just use the default.
    return fallback;
  }
}

export default async function DashboardPage() {
  const [data, brandColor] = await Promise.all([getDashboardData(), getBrandColor()]);

  const { revenue, occupancy, upcomingCount, trend, upcoming, alerts, degraded } = data;
  const totalRevenue = trend.reduce((sum, p) => sum + p.cents, 0);

  return (
    <AdminShell>
      <PageHeader title="Dashboard" description="Your business at a glance." />

      {degraded && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="font-medium">Live data unavailable.</span> Couldn&apos;t reach
          the database, so the figures below are placeholders. Check that the
          deployment&apos;s database environment variables are set.
        </div>
      )}

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Revenue today"
          value={formatUSD(revenue.todayCents)}
          icon={DollarSign}
        />
        <StatCard
          label="Revenue this week"
          value={formatUSD(revenue.weekCents)}
          icon={TrendingUp}
        />
        <StatCard
          label="Revenue this month"
          value={formatUSD(revenue.monthCents)}
          icon={DollarSign}
        />
        <StatCard
          label="Occupancy today"
          value={formatPercent(occupancy.ratio)}
          icon={Gauge}
        />
      </div>

      {/* Trend + occupancy */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <SectionCard
          title="Revenue trend"
          description="Last 14 days, by booking date"
          aside={
            <span className="text-sm font-medium text-slate-500">
              {formatUSD(totalRevenue)}
            </span>
          }
          className="lg:col-span-2"
        >
          <RevenueTrendChart data={trend} brandColor={brandColor} />
        </SectionCard>

        <SectionCard
          title="Occupancy"
          description="Today's booked vs total capacity"
        >
          <OccupancySnapshot
            capacityTotal={occupancy.capacityTotal}
            capacityBooked={occupancy.capacityBooked}
            ratio={occupancy.ratio}
            slices={occupancy.slices}
          />
        </SectionCard>
      </div>

      {/* Upcoming + alerts */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <SectionCard
          title="Upcoming bookings"
          description="The next reservations on the schedule"
          aside={
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
              <CalendarClock className="h-3.5 w-3.5" aria-hidden />
              {formatNumber(upcomingCount)} upcoming
            </span>
          }
          className="lg:col-span-2"
        >
          <UpcomingBookings bookings={upcoming} />
        </SectionCard>

        <SectionCard
          title="Alerts"
          description="Things that need attention"
        >
          <AlertsList alerts={alerts} />
        </SectionCard>
      </div>
    </AdminShell>
  );
}
