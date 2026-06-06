import Link from 'next/link';
import { Plus } from 'lucide-react';
import { AdminShell, PageHeader } from '../../components/shell';
import { ActivitiesTable, type ActivityRow } from '../../components/activities/ActivitiesTable';
import { type ActivityCategory } from '../../components/activities/types';
import { getTenantDb, currentPermissions } from '../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * Activities list — the catalog overview. Tenant-scoped read (RLS + explicit
 * operator filter is implicit through the tenant client). Renders the table via a
 * Client Component (ActivitiesTable) because the column `cell` render functions
 * can't cross the server→client boundary; the page passes only serializable rows.
 */
export default async function ActivitiesPage() {
  const db = await getTenantDb();
  const perms = await currentPermissions();
  const canWrite = perms.has('activity:write');

  const activities = await db.activity.findMany({
    orderBy: [{ sort_index: 'asc' }, { name_internal: 'asc' }],
    select: {
      id: true,
      name_external: true,
      name_internal: true,
      category: true,
      status: true,
      visible_online: true,
      visible_kiosk: true,
      visible_register: true,
      color: true,
      rates: {
        where: { is_active: true },
        select: { price_cents: true },
      },
    },
  });

  const rows: ActivityRow[] = activities.map((a) => {
    const prices = a.rates.map((r) => r.price_cents);
    return {
      id: a.id,
      name_external: a.name_external,
      name_internal: a.name_internal,
      category: a.category as ActivityCategory,
      status: a.status,
      visible_online: a.visible_online,
      visible_kiosk: a.visible_kiosk,
      visible_register: a.visible_register,
      color: a.color,
      rateCount: a.rates.length,
      fromPriceCents: prices.length ? Math.min(...prices) : null,
    };
  });

  return (
    <AdminShell>
      <PageHeader
        title="Activities"
        description="Your bookable catalog — boats, patios, tours, and more."
        actions={
          canWrite ? (
            <Link
              href="/activities/new"
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              <Plus className="h-4 w-4" aria-hidden />
              New activity
            </Link>
          ) : null
        }
      />

      <ActivitiesTable rows={rows} canWrite={canWrite} />
    </AdminShell>
  );
}
