import { AdminShell, PageHeader } from '../../components/shell';
import { ResourcesClient } from '../../components/resources';
import { apiGet, isAdminApiError } from '../../lib/apiClient';
import { getTenantDb, currentPermissions } from '../../lib/session';
import type { ResourceListItem, SelectOption } from '../../components/resources/types';

export const dynamic = 'force-dynamic';

/**
 * Resources list page — the physical-asset catalog that forms the capacity
 * MOAT of the platform.
 *
 * A Resource is a shared physical asset (boat, jet ski, kayak, patio…) that
 * constrains bookable capacity across every Activity it is assigned to. When a
 * booking is taken for any of those activities, it draws down the resource's
 * available units (WHOLE_UNIT) or seats (SHARED_SEATS). Managing resources
 * here ensures the scheduler never over-commits inventory.
 *
 * Reads:  the resource list comes from the API (GET /api/resources) so the
 *         same proven capacity logic is exercised — reads and writes share one
 *         code path (D-029).
 * Writes: all mutations route through `app/resources/actions.ts` → apiClient.
 * Options (locations, activities): loaded direct from DB via the tenant-scoped
 *         client (same pattern as the activity wizard — lightweight reference
 *         data that doesn't need the API's business logic).
 *
 * RBAC: `activity:read` required to view; `activity:write` required to mutate
 *       (matching the API's own permission checks).
 */

interface ApiResourcesResponse {
  resources: ResourceListItem[];
}

export default async function ResourcesPage() {
  // --- RBAC ---------------------------------------------------------------
  const perms = await currentPermissions();
  if (!perms.has('activity:read')) {
    return (
      <AdminShell>
        <PageHeader
          title="Resources"
          description="Physical assets that back your bookable activities."
        />
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-500 shadow-sm">
          You do not have permission to view resources.
        </div>
      </AdminShell>
    );
  }

  const canWrite = perms.has('activity:write');

  // --- Parallel data fetches ----------------------------------------------
  const [resourcesResult, db] = await Promise.all([
    apiGet<ApiResourcesResponse>('/api/resources').then(
      (data) => ({ ok: true as const, data }),
      (err) => ({ ok: false as const, error: isAdminApiError(err) ? err.message : 'Failed to load resources.' }),
    ),
    getTenantDb(),
  ]);

  // Location + activity options for the create/edit form — lightweight
  // reference data loaded direct from the tenant-scoped DB (D-007 pattern,
  // same as loadLocationOptions in activities/loaders.ts).
  const [locationRows, activityRows] = await Promise.all([
    db.location.findMany({
      where: { is_active: true },
      orderBy: [{ is_default: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true },
    }),
    db.activity.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ sort_index: 'asc' }, { name_internal: 'asc' }],
      select: { id: true, name_internal: true },
    }),
  ]);

  const locations: SelectOption[] = locationRows;
  const activities: SelectOption[] = activityRows.map((a) => ({
    id: a.id,
    name: a.name_internal,
  }));

  // --- Error state --------------------------------------------------------
  if (!resourcesResult.ok) {
    return (
      <AdminShell>
        <PageHeader
          title="Resources"
          description="Physical assets that back your bookable activities."
        />
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-6 py-12 text-center text-sm text-rose-700 shadow-sm">
          {resourcesResult.error}
        </div>
      </AdminShell>
    );
  }

  const resources = resourcesResult.data.resources;

  return (
    <AdminShell>
      <PageHeader
        title="Resources"
        description="Physical assets — boats, jet skis, kayaks, patios — that back your bookable activities. A resource assigned to an activity constrains that activity's available capacity."
      />

      {/* Context callout — one-liner MOAT explainer */}
      <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
        <strong className="font-medium text-slate-800">What is a resource?</strong>{' '}
        A resource is a shared physical asset. Assign it to one or more activities and the
        scheduler automatically deducts capacity whenever a booking is placed — preventing
        double-booking across any activity that shares the same asset.
      </div>

      {/* Table + slide-over panel (client) */}
      <ResourcesClient
        resources={resources}
        locations={locations}
        activities={activities}
        canWrite={canWrite}
      />
    </AdminShell>
  );
}
