import { MapPin, ShoppingCart, TrendingUp, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@marina/ui';
import { KpiCard } from '../shell';
import { DataTable, type Column } from '../shell/DataTable';
import { formatDate, formatNumber, formatUSD } from '../../lib/format';

/**
 * Shapes returned by GET /api/reports/by-location.
 * Money is integer cents (the API's `grossCents` fields).
 * Attribution is at the booking-item level (unit_price_cents × quantity),
 * so the total here will not equal operator-wide revenue (which includes
 * tax/tip/fees at the order level). D-020.
 */
export interface LocationStat {
  locationId: string;
  locationName: string;
  bookingCount: number;
  totalQuantity: number;
  grossCents: number;
}

export interface LocationReport {
  from: string;
  to: string;
  byLocation: LocationStat[];
  total: {
    bookingCount: number;
    totalQuantity: number;
    grossCents: number;
  };
}

export interface ByLocationReportViewProps {
  report: LocationReport;
}

/** "Jun 1 – Jun 30, 2026" */
function rangeLabel(from: string, to: string): string {
  return `${formatDate(from)} – ${formatDate(to)}`;
}

/**
 * Per-location roll-up: gross booking value, booking count, and participant
 * quantity broken out per marina/location, plus a chain-total footer row.
 * Revenue is attributed at the item level (not order level) so an order
 * spanning two locations splits correctly. CANCELLED orders are excluded.
 */
export function ByLocationReportView({ report }: ByLocationReportViewProps) {
  const { byLocation, total } = report;

  const columns: Array<Column<LocationStat>> = [
    {
      id: 'location',
      header: 'Location',
      cell: (row) => (
        <span className="flex items-center gap-2 font-medium text-slate-900">
          <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
          {row.locationName}
        </span>
      ),
    },
    {
      id: 'bookings',
      header: 'Bookings',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums text-slate-700">{formatNumber(row.bookingCount)}</span>
      ),
    },
    {
      id: 'quantity',
      header: 'Participants',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums text-slate-700">{formatNumber(row.totalQuantity)}</span>
      ),
    },
    {
      id: 'gross',
      header: 'Gross (item-level)',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums font-medium text-slate-900">
          {formatUSD(row.grossCents)}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Headline KPIs */}
      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard
          label="Item-level gross"
          value={formatUSD(total.grossCents)}
          icon={TrendingUp}
        />
        <KpiCard
          label="Total bookings"
          value={formatNumber(total.bookingCount)}
          icon={ShoppingCart}
        />
        <KpiCard
          label="Total participants"
          value={formatNumber(total.totalQuantity)}
          icon={Users}
        />
      </div>

      {/* Per-location table */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle>Revenue by location</CardTitle>
          <span className="text-xs text-slate-400">{rangeLabel(report.from, report.to)}</span>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            rows={byLocation}
            getRowKey={(row) => row.locationId}
            emptyState={
              <EmptyState
                icon={MapPin}
                title="No location data in this range"
                description="Non-cancelled bookings with a location assigned will appear here."
              />
            }
          />

          {/* Totals footer — only shown when there are rows */}
          {byLocation.length > 0 ? (
            <div className="mt-3 flex items-center justify-between border-t border-slate-200 pt-3 text-sm font-semibold text-slate-900">
              <span>Total (all locations)</span>
              <span className="flex gap-8 tabular-nums">
                <span>{formatNumber(total.bookingCount)} bookings</span>
                <span>{formatNumber(total.totalQuantity)} participants</span>
                <span>{formatUSD(total.grossCents)}</span>
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Attribution note */}
      <p className="text-xs text-slate-400">
        Revenue is attributed at the booking-item level (unit price × quantity) and
        excludes order-level tax, tips, and processing fees. An order spanning multiple
        locations is split accordingly. Use the Revenue report for the operator-wide P&amp;L.
      </p>
    </div>
  );
}
