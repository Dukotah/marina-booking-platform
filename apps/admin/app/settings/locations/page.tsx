import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission } from '../../../lib/session';
import { LocationsManager, type LocationRow } from '../../../components/settings/LocationsManager';

export const dynamic = 'force-dynamic';

/**
 * Locations. Tenant-scoped via getTenantDb (RLS), gated on operator:manage.
 * Default location first, then alphabetical.
 */
export default async function LocationsPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const locations = await db.location.findMany({
    orderBy: [{ is_default: 'desc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      address: true,
      city: true,
      state: true,
      zip: true,
      timezone: true,
      is_default: true,
      is_active: true,
    },
  });

  const rows: LocationRow[] = locations.map((l) => ({
    id: l.id,
    name: l.name,
    address: l.address,
    city: l.city,
    state: l.state,
    zip: l.zip,
    timezone: l.timezone,
    isDefault: l.is_default,
    isActive: l.is_active,
  }));

  return (
    <>
      <PageHeader
        title="Locations"
        description="Add and manage the sites you operate. Chains can run many under one account."
      />
      <LocationsManager locations={rows} />
    </>
  );
}
