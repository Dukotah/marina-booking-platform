import type { Metadata } from 'next';
import { AdminShell, PageHeader } from '../../../components/shell';
import { StatCard } from '../../../components/ui';
import { CatalogTabs } from '../../../components/catalog/CatalogTabs';
import { getTenantDb, requirePermission } from '../../../lib/session';
import { formatUSD } from '../../../lib/format';
import {
  MerchandiseManager,
  type MerchItem,
} from '../../../components/merchandise/MerchandiseManager';

export const metadata: Metadata = {
  title: 'Merchandise',
};

export const dynamic = 'force-dynamic';

/**
 * Catalog — Merchandise tab. The stuff sold at the register that isn't a booking
 * (fuel, tubes, apparel, snacks…). The MerchandiseItem backend + POS selling
 * already existed; this is the missing surface to ADD/edit the catalog. Gated on
 * operator:manage. Built for speed: quick-add at top, inline-editable table below.
 */
export default async function MerchandisePage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const rows = await db.merchandiseItem.findMany({
    orderBy: [{ is_active: 'desc' }, { category: 'asc' }, { name: 'asc' }],
  });

  const items: MerchItem[] = rows.map((m) => ({
    id: m.id,
    name: m.name,
    category: m.category,
    variant: m.variant,
    priceCents: m.price_cents,
    costCents: m.cost_cents,
    onHandQty: m.on_hand_qty,
    reorderAlertQty: m.reorder_alert_qty,
    isActive: m.is_active,
  }));

  const activeCount = items.filter((i) => i.isActive).length;
  const lowStock = items.filter(
    (i) => i.onHandQty !== null && i.reorderAlertQty !== null && i.onHandQty <= i.reorderAlertQty,
  ).length;
  const inventoryValueCents = items.reduce(
    (sum, i) => sum + (i.onHandQty ?? 0) * (i.priceCents ?? 0),
    0,
  );

  return (
    <AdminShell>
      <PageHeader
        title="Merchandise"
        description="Everything you ring up that isn't a booking — fuel, tubes, apparel, snacks. Add items here and they show up at the register."
      />

      <CatalogTabs />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Items on sale" value={String(activeCount)} />
        <StatCard label="Low stock" value={String(lowStock)} tone={lowStock > 0 ? 'owed' : 'neutral'} />
        <StatCard label="Inventory value" value={formatUSD(inventoryValueCents)} />
      </div>

      <MerchandiseManager items={items} />
    </AdminShell>
  );
}
