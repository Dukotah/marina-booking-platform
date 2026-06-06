'use client';

/**
 * Activities list table (client).
 *
 * The column definitions carry `cell` RENDER FUNCTIONS, which cannot be passed
 * from a Server Component to the (client) DataTable — so the table lives here as
 * a Client Component and the server page hands it only serializable props
 * (`rows`, `canWrite`). Mirrors the customers/staff table pattern.
 *
 * Imports the DataTable LEAF (not the shell barrel), since the barrel re-exports
 * AdminShell → lib/session → Clerk server-only code that can't be bundled into a
 * Client Component.
 */

import Link from 'next/link';
import { DataTable, type Column } from '../shell/DataTable';
import { ActivityRowActions } from './ActivityRowActions';
import { CATEGORY_LABELS, type ActivityCategory } from './types';
import { formatUSD } from '../../lib/format';

export interface ActivityRow {
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

export function ActivitiesTable({ rows, canWrite }: { rows: ActivityRow[]; canWrite: boolean }) {
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
  );
}
