import Link from 'next/link';
import { Plus } from 'lucide-react';
import { AdminShell, PageHeader, DataTable, type Column } from '../../components/shell';
import { ActivityRowActions } from '../../components/activities/ActivityRowActions';
import { CATEGORY_LABELS, type ActivityCategory } from '../../components/activities/types';
import { formatUSD } from '../../lib/format';
import { getTenantDb, currentPermissions } from '../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * Activities list — the catalog overview. Tenant-scoped read (RLS + explicit
 * operator filter is implicit through the tenant client). Each row shows category,
 * status, channel visibility, a price-from summary, and inline toggle/edit
 * controls (gated by activity:write).
 */
interface ActivityRow {
  id: string;
  name_external: string;
  name_internal: string;
  category: ActivityCategory;
  status: 'ACTIVE' | 'INACTIVE';
  visible_online: boolean;
  visible_kiosk: boolean;
  visible_register: boolean;
  color: string;
  rateCount: number;
  fromPriceCents: number | null;
}

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

  const columns: Array<Column<ActivityRow>> = [
    {
      id: 'name',
      header: 'Activity',
      cell: (row) => (
        <Link href={`/activities/${row.id}`} className="flex items-center gap-3 hover:underline">
          <span
            className="inline-block h-3 w-3 shrink-0 rounded-full"
            style={{ backgroundColor: row.color }}
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block truncate font-medium text-slate-900">{row.name_external}</span>
            {row.name_internal !== row.name_external ? (
              <span className="block truncate text-xs text-slate-400">{row.name_internal}</span>
            ) : null}
          </span>
        </Link>
      ),
    },
    {
      id: 'category',
      header: 'Category',
      cell: (row) => <span className="text-slate-600">{CATEGORY_LABELS[row.category]}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <span
          className={
            row.status === 'ACTIVE'
              ? 'inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700'
              : 'inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500'
          }
        >
          {row.status === 'ACTIVE' ? 'Active' : 'Inactive'}
        </span>
      ),
    },
    {
      id: 'visibility',
      header: 'Visible',
      cell: (row) => {
        const tags = [
          row.visible_online && 'Online',
          row.visible_kiosk && 'Kiosk',
          row.visible_register && 'Register',
        ].filter(Boolean) as string[];
        return tags.length ? (
          <span className="text-xs text-slate-500">{tags.join(' · ')}</span>
        ) : (
          <span className="text-xs text-slate-400">Hidden</span>
        );
      },
    },
    {
      id: 'rates',
      header: 'Rates',
      align: 'right',
      cell: (row) => <span className="text-slate-600">{row.rateCount}</span>,
    },
    {
      id: 'price',
      header: 'From',
      align: 'right',
      cell: (row) =>
        row.fromPriceCents !== null ? (
          <span className="font-medium text-slate-900">{formatUSD(row.fromPriceCents)}</span>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (row) => (
        <ActivityRowActions
          activityId={row.id}
          status={row.status}
          visibleOnline={row.visible_online}
          canWrite={canWrite}
        />
      ),
    },
  ];

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

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        emptyState={
          <div className="space-y-2">
            <p>No activities yet.</p>
            {canWrite ? (
              <Link href="/activities/new" className="font-medium text-slate-900 underline">
                Create your first activity
              </Link>
            ) : null}
          </div>
        }
      />
    </AdminShell>
  );
}
