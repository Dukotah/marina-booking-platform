import Link from 'next/link';
import { AdminShell } from '../../components/shell/AdminShell';
import { PageHeader } from '../../components/shell/PageHeader';
import { DataTable, type Column } from '../../components/shell/DataTable';
import { OrderStatusBadge, type OrderStatusValue } from '../../components/orders/OrderStatusBadge';
import { OrdersFilters } from '../../components/orders/OrdersFilters';
import { OrdersPagination } from '../../components/orders/OrdersPagination';
import { getTenantDb, requirePermission } from '../../lib/session';
import { formatUSD, formatDateTime, formatDate } from '../../lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;
const ORDER_STATUSES: OrderStatusValue[] = ['UPCOMING', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];

interface OrdersSearchParams {
  search?: string;
  status?: string;
  date?: string;
  page?: string;
}

interface OrderRow {
  id: string;
  orderNumber: string;
  status: OrderStatusValue;
  customerName: string;
  customerEmail: string;
  bookingDate: Date | null;
  itemSummary: string;
  totalCents: number;
  balanceDueCents: number;
  createdAt: Date;
}

/**
 * Orders list — searchable, filterable (status / booking date), paginated. Reads
 * through the tenant-scoped client so RLS guarantees only this operator's orders
 * are returned. White-label: no platform branding; the chrome's brand comes from
 * operator data via AdminShell.
 */
export default async function OrdersPage({
  searchParams,
}: {
  searchParams: OrdersSearchParams;
}) {
  // RBAC: viewing orders requires order:read. Let an AuthorizationError bubble to
  // the route error boundary for a clean denied state.
  await requirePermission('order:read');
  const db = await getTenantDb();

  const search = searchParams.search?.trim() ?? '';
  const statusParam = searchParams.status ?? '';
  const status = ORDER_STATUSES.includes(statusParam as OrderStatusValue)
    ? (statusParam as OrderStatusValue)
    : undefined;
  const dateParam = searchParams.date ?? '';
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1);

  // Date filters by the calendar day a booked timeslot falls on (YYYY-MM-DD).
  let timeslotDateFilter: { gte: Date; lt: Date } | undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    const [y, m, d] = dateParam.split('-').map(Number) as [number, number, number];
    timeslotDateFilter = {
      gte: new Date(y, m - 1, d, 0, 0, 0, 0),
      lt: new Date(y, m - 1, d + 1, 0, 0, 0, 0),
    };
  }

  const where = {
    ...(status ? { status } : {}),
    ...(timeslotDateFilter
      ? { items: { some: { timeslot: { datetime: timeslotDateFilter } } } }
      : {}),
    ...(search
      ? {
          OR: [
            { order_number: { contains: search, mode: 'insensitive' as const } },
            { customer: { first_name: { contains: search, mode: 'insensitive' as const } } },
            { customer: { last_name: { contains: search, mode: 'insensitive' as const } } },
            { customer: { email: { contains: search, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const [records, total] = await Promise.all([
    db.order.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        customer: { select: { first_name: true, last_name: true, email: true } },
        items: {
          orderBy: { created_at: 'asc' },
          select: {
            quantity: true,
            activity: { select: { name_external: true } },
            timeslot: { select: { datetime: true } },
          },
        },
      },
    }),
    db.order.count({ where }),
  ]);

  const rows: OrderRow[] = records.map((order) => {
    const primary = order.items[0];
    const extra = order.items.length - 1;
    const itemSummary = primary
      ? extra > 0
        ? `${primary.activity.name_external} +${extra} more`
        : primary.activity.name_external
      : 'No items';
    return {
      id: order.id,
      orderNumber: order.order_number,
      status: order.status as OrderStatusValue,
      customerName:
        [order.customer.first_name, order.customer.last_name].filter(Boolean).join(' ') || 'Guest',
      customerEmail: order.customer.email,
      bookingDate: primary?.timeslot.datetime ?? null,
      itemSummary,
      totalCents: order.total_cents,
      balanceDueCents: order.balance_due_cents,
      createdAt: order.created_at,
    };
  });

  const columns: Array<Column<OrderRow>> = [
    {
      id: 'orderNumber',
      header: 'Order',
      cell: (row) => (
        <Link
          href={`/orders/${row.id}`}
          className="font-medium text-sky-700 hover:text-sky-900 hover:underline"
        >
          {row.orderNumber}
        </Link>
      ),
    },
    {
      id: 'customer',
      header: 'Customer',
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-slate-800">{row.customerName}</div>
          <div className="truncate text-xs text-slate-500">{row.customerEmail}</div>
        </div>
      ),
    },
    {
      id: 'items',
      header: 'Booking',
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate text-slate-700">{row.itemSummary}</div>
          <div className="text-xs text-slate-500">
            {row.bookingDate ? formatDate(row.bookingDate) : 'Date TBD'}
          </div>
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => <OrderStatusBadge status={row.status} />,
    },
    {
      id: 'total',
      header: 'Total',
      align: 'right',
      cell: (row) => <span className="font-medium text-slate-800">{formatUSD(row.totalCents)}</span>,
    },
    {
      id: 'balance',
      header: 'Balance',
      align: 'right',
      cell: (row) =>
        row.balanceDueCents > 0 ? (
          <span className="font-medium text-amber-700">{formatUSD(row.balanceDueCents)}</span>
        ) : (
          <span className="text-slate-400">Paid</span>
        ),
    },
    {
      id: 'created',
      header: 'Placed',
      cell: (row) => <span className="text-slate-500">{formatDateTime(row.createdAt)}</span>,
    },
  ];

  return (
    <AdminShell>
      <PageHeader title="Orders" description="Search, filter, and manage every booking." />

      <OrdersFilters initialSearch={search} initialStatus={statusParam} initialDate={dateParam} />

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        emptyState={
          search || status || dateParam
            ? 'No orders match these filters.'
            : 'No orders yet. New bookings will appear here.'
        }
      />

      <OrdersPagination page={page} pageSize={PAGE_SIZE} total={total} />
    </AdminShell>
  );
}
