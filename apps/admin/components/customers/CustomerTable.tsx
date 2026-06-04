'use client';

import { useRouter } from 'next/navigation';
import { type Column, DataTable } from '../shell/DataTable';
import { formatDate, formatNumber, formatUSD } from '../../lib/format';
import { Badge } from './Badge';

/** Plain, serializable row shape passed from the server list page. */
export interface CustomerRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  tags: string[];
  lifetimeValueCents: number;
  totalBookings: number;
  lastBookingAt: string | null;
}

export interface CustomerTableProps {
  rows: CustomerRow[];
  /** True when a search filter is active (changes the empty-state copy). */
  isFiltered?: boolean;
}

function fullName(row: CustomerRow): string {
  return `${row.firstName} ${row.lastName}`.trim() || row.email;
}

/**
 * Client wrapper over the shared DataTable: defines the customer columns (LTV,
 * total bookings, last booking, tags) and routes to the profile on row click.
 * Data is fetched server-side and tenant-scoped before it reaches this list.
 */
export function CustomerTable({ rows, isFiltered = false }: CustomerTableProps) {
  const router = useRouter();

  const columns: Array<Column<CustomerRow>> = [
    {
      id: 'name',
      header: 'Customer',
      cell: (row) => (
        <div className="min-w-0">
          <div className="font-medium text-slate-900">{fullName(row)}</div>
          <div className="truncate text-xs text-slate-500">{row.email}</div>
        </div>
      ),
    },
    {
      id: 'phone',
      header: 'Phone',
      cell: (row) => row.phone ?? <span className="text-slate-400">—</span>,
    },
    {
      id: 'tags',
      header: 'Tags',
      cell: (row) =>
        row.tags.length ? (
          <div className="flex flex-wrap gap-1">
            {row.tags.slice(0, 3).map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
            {row.tags.length > 3 ? (
              <Badge className="bg-slate-50 text-slate-400">+{row.tags.length - 3}</Badge>
            ) : null}
          </div>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      id: 'ltv',
      header: 'Lifetime value',
      align: 'right',
      cell: (row) => <span className="font-medium tabular-nums">{formatUSD(row.lifetimeValueCents)}</span>,
    },
    {
      id: 'bookings',
      header: 'Bookings',
      align: 'right',
      cell: (row) => <span className="tabular-nums">{formatNumber(row.totalBookings)}</span>,
    },
    {
      id: 'lastBooking',
      header: 'Last booking',
      align: 'right',
      cell: (row) =>
        row.lastBookingAt ? (
          <span className="tabular-nums text-slate-600">{formatDate(row.lastBookingAt)}</span>
        ) : (
          <span className="text-slate-400">Never</span>
        ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.id}
      onRowClick={(row) => router.push(`/customers/${row.id}`)}
      emptyState={
        isFiltered
          ? 'No customers match your search.'
          : 'No customers yet. They appear here after their first booking.'
      }
    />
  );
}
