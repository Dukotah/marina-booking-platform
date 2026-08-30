import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { AdminShell, PageHeader, DataTable, KpiCard, type Column } from '../../../components/shell';
import { getTenantDb, requirePermission, currentPermissions } from '../../../lib/session';
import { formatUSD, formatNumber, formatDate } from '../../../lib/format';
import {
  MembershipForm,
  type MembershipKind,
} from '../../../components/memberships/MembershipForm';
import { GrantForm } from '../../../components/memberships/GrantForm';
import { RevokeButton } from '../../../components/memberships/RevokeButton';
import {
  benefitLabel,
  durationLabel,
  holdingState,
  kindLabel,
  usesLabel,
} from '../../../components/memberships/holding';

export const metadata: Metadata = {
  title: 'Membership',
};

export const dynamic = 'force-dynamic';

/** Holders shown at once. Beyond this the operator wants a report, not a page. */
const HOLDER_LIMIT = 500;

interface HolderRow {
  id: string;
  customerId: string;
  name: string;
  email: string;
  statusLabel: string;
  badgeClass: string;
  usable: boolean;
  remainingUses: number | null;
  startsAt: Date;
  expiresAt: Date | null;
  purchasedAt: Date;
}

/**
 * One membership product: its terms, who holds it, and how much of it is left.
 *
 * Gated on `activity:read` to see the product. The holder list carries customer
 * PII, so it renders only for `customer:read` — a GUIDE holds activity:read and has
 * no business reading the member roll. Editing needs `activity:write`; granting and
 * revoking need `customer:write`.
 */
export default async function MembershipDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission('activity:read');
  const { id } = await params;

  const db = await getTenantDb();
  const permissions = await currentPermissions();
  const canWrite = permissions.has('activity:write');
  const canReadCustomers = permissions.has('customer:read');
  const canGrant = permissions.has('customer:write');

  const membership = await db.membership.findUnique({ where: { id } });
  if (!membership) notFound();

  const holdings = canReadCustomers
    ? await db.customerMembership.findMany({
        where: { membership_id: id },
        orderBy: { created_at: 'desc' },
        take: HOLDER_LIMIT,
        select: {
          id: true,
          status: true,
          starts_at: true,
          expires_at: true,
          remaining_uses: true,
          created_at: true,
          customer: {
            select: { id: true, first_name: true, last_name: true, email: true },
          },
        },
      })
    : [];

  const rows: HolderRow[] = holdings.map((h) => {
    const state = holdingState(h);
    return {
      id: h.id,
      customerId: h.customer.id,
      name: `${h.customer.first_name} ${h.customer.last_name}`.trim() || h.customer.email,
      email: h.customer.email,
      statusLabel: state.label,
      badgeClass: state.badgeClass,
      usable: state.usable,
      remainingUses: h.remaining_uses,
      startsAt: h.starts_at,
      expiresAt: h.expires_at,
      purchasedAt: h.created_at,
    };
  });

  const usableRows = rows.filter((r) => r.usable);
  const punchesLeft = usableRows.reduce((sum, r) => sum + (r.remainingUses ?? 0), 0);

  const columns: Array<Column<HolderRow>> = [
    {
      id: 'name',
      header: 'Member',
      cell: (r) => (
        <Link
          href={`/customers/${r.customerId}`}
          className="font-medium text-sky-800 underline underline-offset-2 hover:text-sky-900 focus:outline-none focus:ring-2 focus:ring-sky-600"
        >
          {r.name}
        </Link>
      ),
    },
    { id: 'email', header: 'Email', cell: (r) => r.email },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => (
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.badgeClass}`}>
          {r.statusLabel}
        </span>
      ),
    },
    {
      id: 'remaining',
      header: 'Remaining',
      align: 'right',
      cell: (r) =>
        membership.kind === 'PUNCH_CARD' ? usesLabel(r.remainingUses) : 'Unlimited',
    },
    {
      id: 'expires',
      header: 'Expires',
      cell: (r) => (r.expiresAt ? formatDate(r.expiresAt) : 'No expiry'),
    },
    { id: 'issued', header: 'Issued', cell: (r) => formatDate(r.purchasedAt) },
    ...(canGrant
      ? [
          {
            id: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'right' as const,
            cell: (r: HolderRow) =>
              r.usable ? (
                <RevokeButton membershipId={id} holdingId={r.id} holderName={r.name} />
              ) : (
                <span className="text-xs text-slate-600">—</span>
              ),
          },
        ]
      : []),
  ];

  const initial = {
    id: membership.id,
    name: membership.name,
    kind: membership.kind as MembershipKind,
    priceCents: membership.price_cents,
    discountType: membership.discount_type as 'PERCENT' | 'FLAT',
    discountValue: membership.discount_value,
    totalUses: membership.total_uses,
    durationDays: membership.duration_days,
    isActive: membership.is_active,
  };

  return (
    <AdminShell>
      <div className="mb-4">
        <Link
          href="/memberships"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700 underline underline-offset-2 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-sky-600"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          All memberships
        </Link>
      </div>

      <PageHeader
        title={membership.name}
        description={`${kindLabel(membership.kind)} · ${formatUSD(membership.price_cents)} · ${benefitLabel(
          membership.discount_type,
          membership.discount_value,
        )} · ${durationLabel(membership.duration_days)}`}
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Active members" value={formatNumber(usableRows.length)} />
        <KpiCard
          label={membership.kind === 'PUNCH_CARD' ? 'Punches outstanding' : 'Ever issued'}
          value={formatNumber(membership.kind === 'PUNCH_CARD' ? punchesLeft : rows.length)}
        />
        <KpiCard
          label="Member saves per booking"
          value={
            membership.discount_type === 'PERCENT'
              ? `${membership.discount_value}%`
              : formatUSD(membership.discount_value)
          }
        />
      </div>

      {canGrant ? (
        <div className="mb-6">
          <GrantForm membershipId={id} />
        </div>
      ) : null}

      <h2 className="mb-3 text-base font-semibold text-slate-900">Members</h2>
      {canReadCustomers ? (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(r) => r.id}
            caption={`Members holding ${membership.name}`}
            emptyState="Nobody holds this membership yet."
          />
          {rows.length === HOLDER_LIMIT ? (
            <p className="mt-3 text-xs text-slate-600">
              Showing the {formatNumber(HOLDER_LIMIT)} most recent members.
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-slate-600">
          You do not have access to customer records, so the member list is hidden.
        </p>
      )}

      {canWrite ? (
        <div className="mt-8">
          <MembershipForm initial={initial} />
        </div>
      ) : null}
    </AdminShell>
  );
}
