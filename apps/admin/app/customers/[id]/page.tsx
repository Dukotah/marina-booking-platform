import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CalendarClock, DollarSign, Mail, MapPin, Phone, ShieldCheck, Ticket } from 'lucide-react';
import { AdminShell, PageHeader } from '../../../components/shell';
import { Card, StatCard } from '../../../components/ui';
import { getTenantDb, requirePermission, currentPermissions } from '../../../lib/session';
import { formatDate, formatNumber, formatUSD } from '../../../lib/format';
import { TagInput } from '../../../components/customers/TagInput';
import { NotesEditor } from '../../../components/customers/NotesEditor';
import { TaxExemptToggle } from '../../../components/customers/TaxExemptToggle';
import { BookingHistory, type BookingRow } from '../../../components/customers/BookingHistory';

export const metadata: Metadata = {
  title: 'Customer',
};

export const dynamic = 'force-dynamic';

interface CustomerProfileProps {
  params: Promise<{ id: string }>;
}

/** A labeled contact line (icon + value), hidden when the value is absent. */
function ContactLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 text-sm text-ink-body">
      <span className="text-ink-muted" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/**
 * Customer profile: contact details, lifetime value + booking stats, booking
 * history, and editable tags + notes (customer:write). Tenant-scoped via
 * getTenantDb (RLS) and gated on customer:read.
 */
export default async function CustomerProfilePage({ params }: CustomerProfileProps) {
  await requirePermission('customer:read');
  const { id } = await params;

  const db = await getTenantDb();
  const permissions = await currentPermissions();
  const canWrite = permissions.has('customer:write');

  const customer = await db.customer.findUnique({
    where: { id },
    select: {
      id: true,
      first_name: true,
      last_name: true,
      email: true,
      phone: true,
      address: true,
      city: true,
      state: true,
      zip: true,
      tags: true,
      notes: true,
      lifetime_value_cents: true,
      total_bookings: true,
      last_booking_at: true,
      waiver_on_file: true,
      tax_exempt: true,
      created_at: true,
      orders: {
        orderBy: { created_at: 'desc' },
        take: 100,
        select: {
          id: true,
          order_number: true,
          status: true,
          created_at: true,
          total_cents: true,
          balance_due_cents: true,
          items: {
            select: { quantity: true, activity: { select: { name_external: true } } },
          },
        },
      },
    },
  });

  if (!customer) {
    notFound();
  }

  const fullName = `${customer.first_name} ${customer.last_name}`.trim() || customer.email;
  const cityLine = [customer.city, customer.state].filter(Boolean).join(', ');
  const addressLine = [customer.address, [cityLine, customer.zip].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(' · ');

  const bookingRows: BookingRow[] = customer.orders.map((order) => {
    const names = order.items.map((it) => it.activity.name_external);
    const unique = Array.from(new Set(names));
    const itemSummary =
      unique.length === 0
        ? '—'
        : unique.length <= 2
          ? unique.join(', ')
          : `${unique.slice(0, 2).join(', ')} +${unique.length - 2} more`;
    return {
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      createdAt: order.created_at.toISOString(),
      totalCents: order.total_cents,
      balanceDueCents: order.balance_due_cents,
      itemSummary,
    };
  });

  const avgOrderCents =
    customer.total_bookings > 0
      ? Math.round(customer.lifetime_value_cents / customer.total_bookings)
      : 0;

  return (
    <AdminShell>
      <Link
        href="/customers"
        className="mb-3 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to customers
      </Link>

      <PageHeader
        title={fullName}
        description={`Customer since ${formatDate(customer.created_at)}`}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-1">
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-ink">Contact</h2>
            <div className="space-y-2.5">
              <ContactLine icon={<Mail className="h-4 w-4" />}>
                <a href={`mailto:${customer.email}`} className="hover:text-ink hover:underline">
                  {customer.email}
                </a>
              </ContactLine>
              {customer.phone ? (
                <ContactLine icon={<Phone className="h-4 w-4" />}>
                  <a href={`tel:${customer.phone}`} className="hover:text-ink hover:underline">
                    {customer.phone}
                  </a>
                </ContactLine>
              ) : null}
              {addressLine ? (
                <ContactLine icon={<MapPin className="h-4 w-4" />}>{addressLine}</ContactLine>
              ) : null}
              <ContactLine icon={<ShieldCheck className="h-4 w-4" />}>
                {customer.waiver_on_file ? 'Waiver on file' : 'No waiver on file'}
              </ContactLine>
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-ink">Tags</h2>
            <TagInput customerId={customer.id} initialTags={customer.tags} canEdit={canWrite} />
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-ink">Tax status</h2>
            <TaxExemptToggle
              customerId={customer.id}
              initialTaxExempt={customer.tax_exempt}
              canEdit={canWrite}
            />
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-ink">Notes</h2>
            <NotesEditor
              customerId={customer.id}
              initialNotes={customer.notes ?? ''}
              canEdit={canWrite}
            />
          </Card>
        </div>

        <div className="space-y-6 lg:col-span-2">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label="Lifetime value"
              value={formatUSD(customer.lifetime_value_cents)}
              icon={DollarSign}
            />
            <StatCard
              label="Total bookings"
              value={formatNumber(customer.total_bookings)}
              icon={Ticket}
            />
            <StatCard
              label="Last booking"
              value={customer.last_booking_at ? formatDate(customer.last_booking_at) : 'Never'}
              icon={CalendarClock}
            />
          </div>

          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-ink">Booking history</h2>
              {customer.total_bookings > 0 ? (
                <span className="text-xs text-ink-muted">
                  Avg. order {formatUSD(avgOrderCents)}
                </span>
              ) : null}
            </div>
            <BookingHistory rows={bookingRows} />
          </section>
        </div>
      </div>
    </AdminShell>
  );
}
