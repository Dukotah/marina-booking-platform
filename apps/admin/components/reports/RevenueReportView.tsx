import { BarChart3, CalendarRange, Receipt, ShoppingCart, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@marina/ui';
import { KpiCard } from '../shell';
import { formatDate, formatNumber, formatUSD } from '../../lib/format';
import { RevenueReportChart } from './RevenueReportChart';
import type { RevenueReport } from './queries';

export interface RevenueReportViewProps {
  report: RevenueReport;
  brandColor: string;
}

/** Compact "Jun 1 – Jun 30, 2026" range label. */
function rangeLabel(from: string, to: string): string {
  return `${formatDate(from)} – ${formatDate(to)}`;
}

/**
 * Revenue report: headline KPIs, a daily gross-revenue chart, a money breakdown,
 * and a per-activity revenue table. Renders entirely from tenant-scoped data and
 * degrades to clear empty/zero states when there are no orders in the range.
 */
export function RevenueReportView({ report, brandColor }: RevenueReportViewProps) {
  const { totals } = report;
  const hasData = totals.orders > 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Gross revenue" value={formatUSD(totals.grossCents)} icon={TrendingUp} />
        <KpiCard label="Orders" value={formatNumber(totals.orders)} icon={ShoppingCart} />
        <KpiCard
          label="Avg order value"
          value={formatUSD(totals.avgOrderValueCents)}
          icon={Receipt}
        />
        <KpiCard label="Net sales" value={formatUSD(totals.netSalesCents)} icon={BarChart3} />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle>Daily revenue</CardTitle>
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <CalendarRange className="h-3.5 w-3.5" aria-hidden />
            {rangeLabel(report.range.from, report.range.to)}
          </span>
        </CardHeader>
        <CardContent>
          {hasData ? (
            <RevenueReportChart data={report.daily} brandColor={brandColor} />
          ) : (
            <EmptyState
              icon={TrendingUp}
              title="No revenue in this range"
              description="Once orders are booked in the selected dates, daily revenue appears here."
            />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Money breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-slate-100 text-sm">
              <BreakdownRow label="Subtotal" value={formatUSD(totals.subtotalCents)} />
              <BreakdownRow
                label="Discounts"
                value={`−${formatUSD(totals.discountCents)}`}
                muted
              />
              <BreakdownRow label="Net sales" value={formatUSD(totals.netSalesCents)} />
              <BreakdownRow label="Tax" value={formatUSD(totals.taxCents)} />
              <BreakdownRow label="Processing fees" value={formatUSD(totals.processingFeeCents)} />
              <BreakdownRow label="Tips" value={formatUSD(totals.tipCents)} />
              <BreakdownRow label="Gross total" value={formatUSD(totals.grossCents)} strong />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Revenue by activity</CardTitle>
          </CardHeader>
          <CardContent>
            {report.byActivity.length === 0 ? (
              <EmptyState
                icon={BarChart3}
                title="No activity revenue"
                description="Booked activities will rank here by revenue."
              />
            ) : (
              <ul className="flex flex-col divide-y divide-slate-100 text-sm">
                {report.byActivity.map((a) => (
                  <li key={a.activityId} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: a.color }}
                        aria-hidden
                      />
                      <span className="truncate font-medium text-slate-700">{a.activityName}</span>
                    </span>
                    <span className="flex shrink-0 items-baseline gap-3">
                      <span className="text-xs text-slate-400">
                        {formatNumber(a.bookings)} booking{a.bookings === 1 ? '' : 's'}
                      </span>
                      <span className="tabular-nums font-medium text-slate-900">
                        {formatUSD(a.grossCents)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function BreakdownRow({
  label,
  value,
  muted,
  strong,
}: {
  label: string;
  value: string;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
      <dt className={strong ? 'font-semibold text-slate-900' : 'text-slate-500'}>{label}</dt>
      <dd
        className={
          strong
            ? 'tabular-nums text-base font-semibold text-slate-900'
            : muted
              ? 'tabular-nums text-slate-500'
              : 'tabular-nums font-medium text-slate-900'
        }
      >
        {value}
      </dd>
    </div>
  );
}
