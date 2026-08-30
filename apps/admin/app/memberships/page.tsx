import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminShell, PageHeader, DataTable, KpiCard, type Column } from '../../components/shell';
import { getTenantDb, requirePermission, currentPermissions } from '../../lib/session';
import { formatUSD, formatNumber } from '../../lib/format';
import { MembershipForm } from '../../components/memberships/MembershipForm';
import {
  benefitLabel,
  durationLabel,
  holdingState,
  kindLabel,
} from '../../components/memberships/holding';

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
 * Membership products — season passes, punch cards, and standing member rates.
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
          className="font-medium text-sky-800 underline underline-offset-2 hover:text-sky-900 focus:outline-none focus:ring-2 focus:ring-sky-600"
        >
          {r.name}
        </Link>
      ),
    },
    { id: 'kind', header: 'Type', cell: (r) => kindLabel(r.kind) },
    { id: 'price', header: 'Price', align: 'right', cell: (r) => formatUSD(r.priceCents) },
    {
      id: 'benefit',
      header: 'Member gets',
      cell: (r) => benefitLabel(r.discountType, r.discountValue),
    },
    {
      id: 'uses',
      header: 'Uses',
      align: 'right',
      cell: (r) => (r.kind === 'PUNCH_CARD' ? formatNumber(r.totalUses ?? 0) : 'Unlimited'),
    },
    { id: 'validity', header: 'Valid for', cell: (r) => durationLabel(r.durationDays) },
    {
      id: 'holders',
      header: 'Members',
      align: 'right',
      cell: (r) => formatNumber(r.activeHolders),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (r) =>
        r.isActive ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
            For sale
          </span>
        ) : (
          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700">
            Not for sale
          </span>
        ),
    },
  ];

  const description = `${formatNumber(forSale)} for sale · ${formatNumber(distinctMembers.size)} ${
    distinctMembers.size === 1 ? 'member' : 'members'
  }`;

  return (
    <AdminShell>
      <PageHeader
        title="Memberships"
        description={description}
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Memberships for sale" value={formatNumber(forSale)} />
        <KpiCard label="Active members" value={formatNumber(distinctMembers.size)} />
        <KpiCard label="Punches outstanding" value={formatNumber(punchesOutstanding)} />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        caption="Membership products"
        emptyState="No memberships yet. Create a season pass or punch card to start selling one."
      />

      {holdings.length === HOLDING_SCAN_LIMIT ? (
        <p className="mt-3 text-xs text-slate-600">
          Member counts are based on the {formatNumber(HOLDING_SCAN_LIMIT)} most recent active
          memberships.
        </p>
      ) : null}

      {canWrite ? (
        <div className="mt-8">
          <MembershipForm />
        </div>
      ) : (
        <p className="mt-8 text-sm text-slate-600">
          You have read-only access to memberships. Ask an administrator to add or change one.
        </p>
      )}
    </AdminShell>
  );
}
