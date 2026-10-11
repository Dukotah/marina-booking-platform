import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminShell, PageHeader, DataTable, type Column } from '../../../components/shell';
import { StatCard, Badge } from '../../../components/ui';
import { CatalogTabs } from '../../../components/catalog/CatalogTabs';
import { getTenantDb, requirePermission, currentPermissions } from '../../../lib/session';
import { formatUSD, formatNumber } from '../../../lib/format';
import { MembershipForm } from '../../../components/memberships/MembershipForm';
import {
  benefitLabel,
  durationLabel,
  holdingState,
  kindLabel,
} from '../../../components/memberships/holding';

export const metadata: Metadata = {
  title: 'Memberships',
};

export const dynamic = 'force-dynamic';

/**
 * How many holdings the roll-up reads. A marina's whole membership base is in the
 * hundreds, so this is a guard against a pathological tenant rather than a real
 * limit; the number of holdings actually read is stated on screen when it bites,
 * because a silently truncated count is a wrong count.
 */
const HOLDING_SCAN_LIMIT = 5000;

interface ProductRow {
  id: string;
  name: string;
  kind: string;
  isActive: boolean;
  priceCents: number;
  discountType: string;
  discountValue: number;
  totalUses: number | null;
  durationDays: number | null;
  activeHolders: number;
}

/**
 * Catalog — Memberships tab (the old /memberships page, moved here when the
 * sidebar was consolidated; the old route redirects, /memberships/[id] detail
 * links keep working). Season passes, punch cards, and standing member rates.
 *
 * Tenant-scoped via getTenantDb (RLS). Reading the catalog is `activity:read`
 * (a membership is a sellable product, gated like packages); creating one needs
 * `activity:write`, so a line STAFF member sees the list and no form.
 *
 * The holder roll-up is computed from live holdings rather than a stored counter,
 * and it counts USABLE holdings — a season pass whose window has closed still sits
 * at status ACTIVE until a booking touches it, and counting those would tell the
 * owner he has more members than he can sell to.
 */
export default async function MembershipsPage() {
  await requirePermission('activity:read');
  const db = await getTenantDb();
  const permissions = await currentPermissions();
  const canWrite = permissions.has('activity:write');

  const [products, holdings] = await Promise.all([
    db.membership.findMany({ orderBy: [{ is_active: 'desc' }, { price_cents: 'asc' }] }),
    db.customerMembership.findMany({
      where: { status: 'ACTIVE' },
      take: HOLDING_SCAN_LIMIT,
      select: {
        membership_id: true,
        customer_id: true,
        status: true,
        starts_at: true,
        expires_at: true,
        remaining_uses: true,
      },
    }),
  ]);

  const usable = holdings.filter((h) => holdingState(h).usable);
  const holdersByProduct = new Map<string, number>();
  const distinctMembers = new Set<string>();
  let punchesOutstanding = 0;
  for (const h of usable) {
    holdersByProduct.set(h.membership_id, (holdersByProduct.get(h.membership_id) ?? 0) + 1);
    distinctMembers.add(h.customer_id);
    if (h.remaining_uses != null) punchesOutstanding += h.remaining_uses;
  }

  const rows: ProductRow[] = products.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    isActive: p.is_active,
    priceCents: p.price_cents,
    discountType: p.discount_type,
    discountValue: p.discount_value,
    totalUses: p.total_uses,
    durationDays: p.duration_days,
    activeHolders: holdersByProduct.get(p.id) ?? 0,
  }));

  const forSale = rows.filter((r) => r.isActive).length;

  const columns: Array<Column<ProductRow>> = [
    {
      id: 'name',
      header: 'Membership',
      cell: (r) => (
        <Link
          href={`/memberships/${r.id}`}
          className="font-medium text-accent hover:text-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {r.name}
        </Link>
      ),
    },
    { id: 'kind', header: 'Type', cell: (r) => kindLabel(r.kind) },
    {
      id: 'price',
      header: 'Price',
      align: 'right',
      cell: (r) => <span className="tabular-nums">{formatUSD(r.priceCents)}</span>,
    },
    {
      id: 'benefit',
      header: 'Member gets',
      cell: (r) => benefitLabel(r.discountType, r.discountValue),
    },
    {
      id: 'uses',
      header: 'Uses',
      align: 'right',
      cell: (r) => (
        <span className="tabular-nums">
          {r.kind === 'PUNCH_CARD' ? formatNumber(r.totalUses ?? 0) : 'Unlimited'}
        </span>
      ),
    },
    { id: 'validity', header: 'Valid for', cell: (r) => durationLabel(r.durationDays) },
    {
      id: 'holders',
      header: 'Members',
      align: 'right',
      cell: (r) => <span className="tabular-nums">{formatNumber(r.activeHolders)}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => (
        <Badge tone={r.isActive ? 'success' : 'cancelled'}>
          {r.isActive ? 'For sale' : 'Not for sale'}
        </Badge>
      ),
    },
  ];

  const description = `${formatNumber(forSale)} for sale · ${formatNumber(distinctMembers.size)} ${
    distinctMembers.size === 1 ? 'member' : 'members'
  }`;

  return (
    <AdminShell>
      <PageHeader title="Memberships" description={description} />

      <CatalogTabs />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Memberships for sale" value={formatNumber(forSale)} />
        <StatCard label="Active members" value={formatNumber(distinctMembers.size)} tone="success" />
        <StatCard label="Punches outstanding" value={formatNumber(punchesOutstanding)} />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        caption="Membership products"
        emptyState="No memberships yet. Create a season pass or punch card to start selling one."
      />

      {holdings.length === HOLDING_SCAN_LIMIT ? (
        <p className="mt-3 text-xs text-ink-body">
          Member counts are based on the {formatNumber(HOLDING_SCAN_LIMIT)} most recent active
          memberships.
        </p>
      ) : null}

      {canWrite ? (
        <div className="mt-8">
          <MembershipForm />
        </div>
      ) : (
        <p className="mt-8 text-sm text-ink-body">
          You have read-only access to memberships. Ask an administrator to add or change one.
        </p>
      )}
    </AdminShell>
  );
}
