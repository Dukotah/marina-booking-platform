import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission } from '../../../lib/session';
import {
  ResourcesManager,
  type ResourceRow,
  type ActivityOption,
} from '../../../components/settings/ResourcesManager';

export const dynamic = 'force-dynamic';

/**
 * Shared resources (D-014). Tenant-scoped via getTenantDb (RLS), gated on
 * operator:manage. Loads each pool with its linked activity ids plus the full
 * activity list so pools can be (re)linked.
 */
export default async function ResourcesPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const [resources, activities] = await Promise.all([
    db.resource.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        quantity: true,
        seat_capacity: true,
        out_of_service_qty: true,
        is_active: true,
        activities: { select: { id: true } },
      },
    }),
    db.activity.findMany({
      orderBy: { name_internal: 'asc' },
      select: { id: true, name_internal: true },
    }),
  ]);

  const resourceRows: ResourceRow[] = resources.map((r) => ({
    id: r.id,
    name: r.name,
    quantity: r.quantity,
    seatCapacity: r.seat_capacity,
    outOfServiceQty: r.out_of_service_qty,
    isActive: r.is_active,
    activityIds: r.activities.map((a) => a.id),
  }));

  const activityOptions: ActivityOption[] = activities.map((a) => ({
    id: a.id,
    name: a.name_internal,
  }));

  return (
    <>
      <PageHeader
        title="Shared resources"
        description="Pools of physical inventory (boats, jet skis, guides) shared across activities — the capacity backbone that prevents double-booking."
      />
      <ResourcesManager resources={resourceRows} activities={activityOptions} />
    </>
  );
}
