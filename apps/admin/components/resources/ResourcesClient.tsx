'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
// Import the leaf file, not the shell barrel: the barrel re-exports AdminShell,
// which pulls lib/session → Clerk server-only code that can't be bundled into a
// Client Component (known repo gotcha, D-009 era).
import { DataTable, type Column } from '../shell/DataTable';
import { ResourceRowActions } from './ResourceRowActions';
import { ResourcePanel } from './ResourcePanel';
import {
  type ResourceListItem,
  type SelectOption,
  ALLOCATION_MODE_LABELS,
} from './types';

/**
 * Client shell for the resources list page. Owns the add/edit panel state and
 * refreshes the server component via router.refresh() after mutations so the
 * table stays in sync without a full page reload.
 */
export function ResourcesClient({
  resources,
  locations,
  activities,
  canWrite,
}: {
  resources: ResourceListItem[];
  locations: SelectOption[];
  activities: SelectOption[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [panelOpen, setPanelOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<
    (ResourceListItem & { activityIds?: string[] }) | undefined
  >(undefined);

  function openCreate() {
    setEditTarget(undefined);
    setPanelOpen(true);
  }

  function openEdit(resource: ResourceListItem) {
    setEditTarget(resource);
    setPanelOpen(true);
  }

  function closePanel() {
    setPanelOpen(false);
    setEditTarget(undefined);
    // Refresh the server component to pick up any mutations.
    router.refresh();
  }

  const columns: Array<Column<ResourceListItem>> = [
    {
      id: 'name',
      header: 'Resource',
      cell: (row) => (
        <div className="min-w-0">
          <span className="block truncate font-medium text-slate-900">{row.name}</span>
          {!row.isActive ? (
            <span className="mt-0.5 inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-400">
              Inactive
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'mode',
      header: 'Mode',
      cell: (row) => (
        <span className="text-slate-600">{ALLOCATION_MODE_LABELS[row.allocationMode]}</span>
      ),
    },
    {
      id: 'seats',
      header: 'Seats/unit',
      align: 'right',
      cell: (row) => <span className="text-slate-700">{row.seatCapacity}</span>,
    },
    {
      id: 'qty',
      header: 'Units',
      align: 'right',
      cell: (row) => <span className="text-slate-700">{row.quantity}</span>,
    },
    {
      id: 'oos',
      header: 'Out of svc',
      align: 'right',
      cell: (row) =>
        row.outOfServiceQty > 0 ? (
          <span className="font-medium text-amber-600">{row.outOfServiceQty}</span>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      id: 'available',
      header: 'Available',
      align: 'right',
      cell: (row) => (
        <span
          className={
            row.availableQty === 0 ? 'font-medium text-rose-600' : 'font-medium text-emerald-700'
          }
        >
          {row.availableQty}
        </span>
      ),
    },
    {
      id: 'activities',
      header: 'Activities',
      align: 'right',
      cell: (row) => (
        <span className="text-slate-600">{row.activityCount}</span>
      ),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (row) => (
        <ResourceRowActions resource={row} canWrite={canWrite} onEdit={openEdit} />
      ),
    },
  ];

  return (
    <>
      {/* Add button — shown inline above the table on the page (server passes canWrite,
          but we also render the button here so it can open the panel client-side) */}
      {canWrite ? (
        <div className="mb-6 flex justify-end">
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add resource
          </button>
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={resources}
        getRowKey={(row) => row.id}
        emptyState={
          <div className="space-y-2">
            <p className="text-slate-500">No resources yet.</p>
            {canWrite ? (
              <button
                type="button"
                onClick={openCreate}
                className="font-medium text-slate-900 underline"
              >
                Add your first resource
              </button>
            ) : null}
          </div>
        }
      />

      <ResourcePanel
        open={panelOpen}
        mode={editTarget ? 'edit' : 'create'}
        resource={editTarget}
        locations={locations}
        activities={activities}
        onClose={closePanel}
      />
    </>
  );
}
