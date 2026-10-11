import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission } from '../../../lib/session';
import {
  ChargePresetsManager,
  type ChargePresetRow,
} from '../../../components/settings/ChargePresetsManager';

export const dynamic = 'force-dynamic';

/**
 * Charge presets. Tenant-scoped via getTenantDb (RLS), gated on operator:manage.
 * Reusable one-click charges (fuel, cleaning, damage, late) that pre-fill the
 * "Add fuel / charge" flow on the order + manifest.
 */
export default async function ChargePresetsPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const presets = await db.chargePreset.findMany({
    orderBy: [{ active: 'desc' }, { label: 'asc' }],
    select: {
      id: true,
      label: true,
      category: true,
      amount_cents: true,
      active: true,
    },
  });

  const rows: ChargePresetRow[] = presets.map((p) => ({
    id: p.id,
    label: p.label,
    category: p.category,
    amountCents: p.amount_cents,
    active: p.active,
  }));

  return (
    <>
      <PageHeader
        title="Charge Presets"
        description="Save the post-trip charges you add again and again, so staff can apply them in one tap."
      />
      <ChargePresetsManager presets={rows} />
    </>
  );
}
