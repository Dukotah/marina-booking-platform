import type { Metadata } from 'next';
import { AdminShell, PageHeader } from '../../components/shell';
import { getTenantDb, requirePermission } from '../../lib/session';
import { formatNumber } from '../../lib/format';
import { PromoTable, type PromoRow } from '../../components/promos/PromoTable';
import { CreatePromoDialog } from '../../components/promos/CreatePromoDialog';

export const metadata: Metadata = {
  title: 'Promo Codes',
};

export const dynamic = 'force-dynamic';

/**
 * Promo code management. Tenant-scoped via getTenantDb (RLS), gated on
 * operator:manage. Lists all codes with discount, redemption counts, and date
 * range; operators can create, pause/resume, and delete codes inline.
 */
export default async function PromosPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const promos = await db.promoCode.findMany({
    orderBy: [{ is_active: 'desc' }, { code: 'asc' }],
  });

  const rows: PromoRow[] = promos.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    discountType: p.discount_type,
    discountValue: p.discount_value,
    isActive: p.is_active,
    timesRedeemed: p.times_redeemed,
    maxRedemptions: p.max_redemptions,
    validFrom: p.valid_from ? p.valid_from.toISOString() : null,
    validUntil: p.valid_until ? p.valid_until.toISOString() : null,
  }));

  const activeCount = rows.filter((r) => r.isActive).length;
  const description =
    promos.length === 0
      ? 'No promo codes yet.'
      : `${formatNumber(promos.length)} ${promos.length === 1 ? 'code' : 'codes'} · ${formatNumber(activeCount)} active`;

  return (
    <AdminShell>
      <PageHeader
        title="Promo Codes"
        description={description}
        actions={<CreatePromoDialog />}
      />
      <PromoTable rows={rows} />
    </AdminShell>
  );
}
