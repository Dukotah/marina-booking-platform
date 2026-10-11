'use client';

import { useRouter } from 'next/navigation';
import { type Column, DataTable } from '../shell/DataTable';
import { formatDate, formatUSD } from '../../lib/format';
import { Badge, type BadgeTone } from '../ui';

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

// Status color law: UPCOMING is quiet/neutral (slate), COMPLETED reads as a
// finished/past booking (slate/cancelled), CANCELLED is the muted inactive
// slate, and NO_SHOW is the amber attention tone.
const STATUS_TONES: Record<string, BadgeTone> = {
  UPCOMING: 'neutral',
  COMPLETED: 'cancelled',
  CANCELLED: 'cancelled',
  NO_SHOW: 'waiver',
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
          <div className="font-medium text-ink">{row.orderNumber}</div>
          <div className="truncate text-xs text-ink-muted">{row.itemSummary}</div>
        </div>
      ),
    },
    {
      id: 'date',
      header: 'Date',
      cell: (row) => <span className="text-ink-body">{formatDate(row.createdAt)}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <Badge tone={STATUS_TONES[row.status] ?? 'neutral'}>{statusLabel(row.status)}</Badge>
      ),
    },
    {
      id: 'balance',
      header: 'Balance due',
      align: 'right',
      cell: (row) =>
        row.balanceDueCents > 0 ? (
          <span className="font-medium tabular-nums text-rose-700">
            {formatUSD(row.balanceDueCents)}
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
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
