import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission } from '../../../lib/session';
import {
  FeesManager,
  type FeeRow,
  type ActivityOption,
} from '../../../components/settings/FeesManager';

export const dynamic = 'force-dynamic';

/**
 * Fees & taxes. Tenant-scoped via getTenantDb (RLS), gated on operator:manage.
 * Loads fees + the activity list so a fee can be scoped to a single activity.
 */
export default async function FeesPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const [fees, activities] = await Promise.all([
    db.fee.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        type: true,
        value: true,
        enabled: true,
        ignore_tax_exempt: true,
        activity_id: true,
      },
    }),
    db.activity.findMany({
      orderBy: { name_internal: 'asc' },
      select: { id: true, name_internal: true },
    }),
  ]);

  const feeRows: FeeRow[] = fees.map((f) => ({
    id: f.id,
    name: f.name,
    type: f.type,
    value: f.value,
    enabled: f.enabled,
    ignore_tax_exempt: f.ignore_tax_exempt,
    activityId: f.activity_id,
  }));

  const activityOptions: ActivityOption[] = activities.map((a) => ({
    id: a.id,
    name: a.name_internal,
  }));

  return (
    <>
      <PageHeader
        title="Fees & Taxes"
        description="Sales tax, card processing, and any custom charges added to orders."
      />
      <FeesManager fees={feeRows} activities={activityOptions} />
    </>
  );
}
