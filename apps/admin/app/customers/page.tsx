import type { Metadata } from 'next';
import { Prisma } from '@marina/database';
import { AdminShell, PageHeader } from '../../components/shell';
import { getTenantDb, requirePermission } from '../../lib/session';
import { CustomerSearch } from '../../components/customers/CustomerSearch';
import { CustomerTable, type CustomerRow } from '../../components/customers/CustomerTable';
import { formatNumber, formatUSD } from '../../lib/format';

export const metadata: Metadata = {
  title: 'Customers',
};

export const dynamic = 'force-dynamic';

interface CustomersPageProps {
  searchParams: Promise<{ q?: string }>;
}

/**
 * Customer CRM list. Tenant-scoped via getTenantDb (RLS) and gated on
 * customer:read. Searchable across name, email, phone, and tags; surfaces LTV,
 * total bookings, last booking, and tags per the foundation DataTable.
 */
export default async function CustomersPage({ searchParams }: CustomersPageProps) {
  await requirePermission('customer:read');
  const db = await getTenantDb();

  const { q } = await searchParams;
  const query = (q ?? '').trim();

  const where: Prisma.CustomerWhereInput = query
    ? {
        OR: [
          { first_name: { contains: query, mode: 'insensitive' } },
          { last_name: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
          { phone: { contains: query, mode: 'insensitive' } },
          { tags: { has: query } },
        ],
      }
    : {};

  const [customers, totalCount, aggregate] = await Promise.all([
    db.customer.findMany({
      where,
      orderBy: [{ lifetime_value_cents: 'desc' }, { last_name: 'asc' }],
      take: 200,
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        phone: true,
        tags: true,
        lifetime_value_cents: true,
        total_bookings: true,
        last_booking_at: true,
      },
    }),
    db.customer.count(),
    db.customer.aggregate({ _sum: { lifetime_value_cents: true } }),
  ]);

  const rows: CustomerRow[] = customers.map((c) => ({
    id: c.id,
    firstName: c.first_name,
    lastName: c.last_name,
    email: c.email,
    phone: c.phone,
    tags: c.tags,
    lifetimeValueCents: c.lifetime_value_cents,
    totalBookings: c.total_bookings,
    lastBookingAt: c.last_booking_at ? c.last_booking_at.toISOString() : null,
  }));

  const totalLtvCents = aggregate._sum.lifetime_value_cents ?? 0;
  const description = query
    ? `${formatNumber(rows.length)} matching ${rows.length === 1 ? 'customer' : 'customers'}`
    : `${formatNumber(totalCount)} ${totalCount === 1 ? 'customer' : 'customers'} · ${formatUSD(totalLtvCents)} lifetime value`;

  return (
    <AdminShell>
      <PageHeader title="Customers" description={description} actions={<CustomerSearch />} />
      <CustomerTable rows={rows} isFiltered={Boolean(query)} />
      {rows.length === 200 && !query ? (
        <p className="mt-3 text-xs text-slate-400">
          Showing the top 200 by lifetime value. Use search to find a specific customer.
        </p>
      ) : null}
    </AdminShell>
  );
}
