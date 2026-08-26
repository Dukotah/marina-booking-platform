import { Building2, CalendarRange, Gauge, MapPin, Receipt } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@marina/ui';
import { KpiCard } from '../shell';
import { formatUSD, formatDate, formatNumber, formatPercent } from '../../lib/format';
import type { LocationRollUpReport } from './queries';

export interface LocationRollUpViewProps {
  report: LocationRollUpReport;
}

function rangeLabel(from: string, to: string): string {
  return `${formatDate(from)} – ${formatDate(to)}`;
}

/** Clamp a 0–1 ratio to a CSS bar width percentage. */
function barWidth(ratio: number): string {
  return `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(0)}%`;
}

/**
 * Multi-location roll-up (Upmarket §1 #6-B): combined revenue + occupancy across
 * every location, read-only. KPIs summarize the chain; a table ranks locations by
 * gross revenue with per-location occupancy and revenue share. Graceful when a
 * single-location operator has no location rows (renders an empty state).
 */
export function LocationRollUpView({ report }: LocationRollUpViewProps) {
  const { totals, rows } = report;
  const hasData = rows.length > 0 && (totals.grossCents > 0 || totals.capacityTotal > 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Combined revenue" value={formatUSD(totals.grossCents)} icon={Receipt} />
        <KpiCard label="Locations" value={formatNumber(totals.locations)} icon={Building2} />
        <KpiCard label="Orders" value={formatNumber(totals.orders)} icon={Receipt} />
        <KpiCard label="Combined occupancy" value={formatPercent(totals.occupancy)} icon={Gauge} />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle>Revenue &amp; occupancy by location</CardTitle>
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <CalendarRange className="h-3.5 w-3.5" aria-hidden />
            {rangeLabel(report.range.from, report.range.to)}
          </span>
        </CardHeader>
        <CardContent>
          {!hasData ? (
            <EmptyState
              icon={MapPin}
              title="No location activity in this range"
              description="Once activities scoped to a location have bookings or timeslots in the selected dates, the roll-up appears here."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs font-medium text-slate-500">
                    <th className="py-2 pr-4">Location</th>
                    <th className="py-2 pr-4 text-right">Revenue</th>
                    <th className="py-2 pr-4 text-right">Share</th>
                    <th className="py-2 pr-4 text-right">Orders</th>
                    <th className="py-2 pr-4 text-right">Seats</th>
                    <th className="py-2 pl-4 text-right">Occupancy</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.locationId ?? '__none__'}
                      className="border-b border-slate-100 last:border-0"
                    >
                      <td className="py-2.5 pr-4 font-medium text-slate-800">
                        <span className="flex items-center gap-2">
                          <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
                          <span className="truncate">{r.locationName}</span>
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums font-medium text-slate-900">
                        {formatUSD(r.grossCents)}
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums text-slate-500">
                        {formatPercent(r.revenueShare)}
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums text-slate-500">
                        {formatNumber(r.orders)}
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums text-slate-500">
                        {r.capacityBooked}/{r.capacityTotal}
                      </td>
                      <td className="py-2.5 pl-4">
                        <span className="flex items-center justify-end gap-2">
                          <span className="hidden h-2 w-24 overflow-hidden rounded-full bg-slate-100 sm:block">
                            <span
                              className="block h-full rounded-full bg-[var(--brand-color,#0ea5e9)]"
                              style={{ width: barWidth(r.occupancy) }}
                            />
                          </span>
                          <span className="tabular-nums font-medium text-slate-900">
                            {formatPercent(r.occupancy)}
                          </span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
