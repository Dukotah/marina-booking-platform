'use client';

import { useRouter } from 'next/navigation';
import { type Column, DataTable } from '../shell/DataTable';
import { formatDate, formatUSD } from '../../lib/format';
import { cn } from '../../lib/cn';

/** Serializable order row for a customer's booking history. */
export interface BookingRow {
  id: string;
  orderNumber: string;
  status: string;
  createdAt: string;
  totalCents: number;
  balanceDueCents: number;
  itemSummary: string;
}

export interface BookingHistoryProps {
  rows: BookingRow[];
}

const STATUS_STYLES: Record<string, string> = {
  UPCOMING: 'bg-sky-50 text-sky-700',
  COMPLETED: 'bg-emerald-50 text-emerald-700',
  CANCELLED: 'bg-slate-100 text-slate-500',
  NO_SHOW: 'bg-amber-50 text-amber-700',
};

function statusLabel(status: string): string {
  return status
    .toLowerCase()
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/**
 * Read-only booking history table for a single customer. Rows are fetched
 * server-side (tenant-scoped) and clicking one navigates to the order detail.
 */
export function BookingHistory({ rows }: BookingHistoryProps) {
  const router = useRouter();

  const columns: Array<Column<BookingRow>> = [
    {
      id: 'order',
      header: 'Order',
      cell: (row) => (
        <div className="min-w-0">
          <div className="font-medium text-slate-900">{row.orderNumber}</div>
          <div className="truncate text-xs text-slate-500">{row.itemSummary}</div>
        </div>
      ),
    },
    {
      id: 'date',
      header: 'Date',
      cell: (row) => <span className="text-slate-600">{formatDate(row.createdAt)}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
            STATUS_STYLES[row.status] ?? 'bg-slate-100 text-slate-600',
          )}
        >
          {statusLabel(row.status)}
        </span>
      ),
    },
    {
      id: 'balance',
      header: 'Balance due',
      align: 'right',
      cell: (row) =>
        row.balanceDueCents > 0 ? (
          <span className="font-medium tabular-nums text-amber-700">
            {formatUSD(row.balanceDueCents)}
          </span>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      id: 'total',
      header: 'Total',
      align: 'right',
      cell: (row) => <span className="font-medium tabular-nums">{formatUSD(row.totalCents)}</span>,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.id}
      onRowClick={(row) => router.push(`/orders/${row.id}`)}
      emptyState="No bookings yet."
    />
  );
}
