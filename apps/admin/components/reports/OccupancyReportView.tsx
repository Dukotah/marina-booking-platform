import { Activity, CalendarRange, Gauge, Ship, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@marina/ui';
import { KpiCard } from '../shell';
import { formatDate, formatNumber, formatPercent } from '../../lib/format';
import { OccupancyReportChart } from './OccupancyReportChart';
import type { OccupancyReport } from './queries';

export interface OccupancyReportViewProps {
  report: OccupancyReport;
  brandColor: string;
}

function rangeLabel(from: string, to: string): string {
  return `${formatDate(from)} – ${formatDate(to)}`;
}

/** Clamp a 0–1 ratio to a CSS bar width percentage. */
function barWidth(ratio: number): string {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return `${pct.toFixed(0)}%`;
}

/**
 * Occupancy report: how full the operator's capacity ran across the range. KPIs
 * summarize seats booked vs total and overall utilization; a daily line chart
 * shows the trend; a per-activity table ranks utilization. Timeslot-based (keyed
 * on when activities run), tenant-scoped, and graceful when there are no slots.
 */
export function OccupancyReportView({ report, brandColor }: OccupancyReportViewProps) {
  const { totals } = report;
  const hasData = totals.capacityTotal > 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Occupancy" value={formatPercent(totals.ratio)} icon={Gauge} />
        <KpiCard label="Seats booked" value={formatNumber(totals.capacityBooked)} icon={Users} />
        <KpiCard label="Seats available" value={formatNumber(totals.capacityTotal)} icon={Ship} />
        <KpiCard label="Timeslots" value={formatNumber(totals.slots)} icon={Activity} />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle>Daily occupancy</CardTitle>
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <CalendarRange className="h-3.5 w-3.5" aria-hidden />
            {rangeLabel(report.range.from, report.range.to)}
          </span>
        </CardHeader>
        <CardContent>
          {hasData ? (
            <OccupancyReportChart data={report.daily} brandColor={brandColor} />
          ) : (
            <EmptyState
              icon={Gauge}
              title="No timeslots in this range"
              description="Once activities have scheduled timeslots in the selected dates, occupancy appears here."
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Occupancy by activity</CardTitle>
        </CardHeader>
        <CardContent>
          {report.byActivity.length === 0 ? (
            <EmptyState
              icon={Ship}
              title="No activity capacity"
              description="Activities with timeslots in this range will rank here by utilization."
            />
          ) : (
            <ul className="flex flex-col gap-4">
              {report.byActivity.map((a) => (
                <li key={a.activityId} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: a.color }}
                        aria-hidden
                      />
                      <span className="truncate font-medium text-slate-700">{a.activityName}</span>
                    </span>
                    <span className="flex shrink-0 items-baseline gap-3 tabular-nums">
                      <span className="text-xs text-slate-400">
                        {a.capacityBooked}/{a.capacityTotal} seats
                      </span>
                      <span className="font-medium text-slate-900">{formatPercent(a.ratio)}</span>
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full"
                      style={{ width: barWidth(a.ratio), backgroundColor: a.color }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
