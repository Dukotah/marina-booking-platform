import Link from 'next/link';
import type { Metadata } from 'next';
import { Plus } from 'lucide-react';
import { AdminShell, PageHeader, DataTable, type Column } from '../../../components/shell';
import { Badge, buttonClasses } from '../../../components/ui';
import { CatalogTabs } from '../../../components/catalog/CatalogTabs';
import { PackageRowActions } from '../../../components/packages/PackageRowActions';
import { formatUSD } from '../../../lib/format';
import { getTenantDb, currentPermissions } from '../../../lib/session';

export const metadata: Metadata = {
  title: 'Packages',
};

export const dynamic = 'force-dynamic';

interface PackageRow {
  id: string;
  name: string;
  priceCents: number;
  itemCount: number;
  status: 'ACTIVE' | 'INACTIVE';
  visibleOnline: boolean;
}

/**
 * Catalog — Packages tab. Lists the operator's sellable activity/rate bundles and
 * links to the builder. The bundle price is authoritative (it need not equal the
 * sum of its lines — the discount is the point).
 */
export default async function PackagesListPage() {
  const db = await getTenantDb();
  const perms = await currentPermissions();
  const canWrite = perms.has('activity:write');

  const packages = await db.package.findMany({
    orderBy: [{ sort_index: 'asc' }, { name_internal: 'asc' }],
    select: {
      id: true,
      name_external: true,
      name_internal: true,
      price_cents: true,
      status: true,
      visible_online: true,
      _count: { select: { items: true } },
    },
  });

  const rows: PackageRow[] = packages.map((p) => ({
    id: p.id,
    name: p.name_external || p.name_internal,
    priceCents: p.price_cents,
    itemCount: p._count.items,
    status: p.status,
    visibleOnline: p.visible_online,
  }));

  const columns: Array<Column<PackageRow>> = [
    {
      id: 'name',
      header: 'Package',
      cell: (r) => (
        <div className="flex flex-col">
          <span className="font-medium text-ink">{r.name}</span>
          <span className="text-xs text-ink-muted">
            {r.itemCount} item{r.itemCount === 1 ? '' : 's'}
          </span>
        </div>
      ),
    },
    {
      id: 'price',
      header: 'Price',
      cell: (r) => <span className="font-medium text-ink tabular-nums">{formatUSD(r.priceCents)}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => (
        <div className="flex gap-1.5">
          <Badge tone={r.status === 'ACTIVE' ? 'success' : 'neutral'}>
            {r.status === 'ACTIVE' ? 'Active' : 'Inactive'}
          </Badge>
          {r.visibleOnline ? <Badge tone="accent">Online</Badge> : null}
        </div>
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: (r) => <PackageRowActions packageId={r.id} name={r.name} canWrite={canWrite} />,
    },
  ];

  return (
    <AdminShell>
      <PageHeader
        title="Catalog"
        description="Bundle activities into a single-price package to upsell and lift average order value."
        actions={
          canWrite ? (
            <Link href="/catalog/packages/new" className={buttonClasses('primary', 'md')}>
              <Plus className="h-4 w-4" aria-hidden />
              New package
            </Link>
          ) : null
        }
      />

      <CatalogTabs />

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        emptyState="No packages yet. Create one to bundle activities at a discount."
      />
    </AdminShell>
  );
}
