'use client';

import { useState, useTransition } from 'react';
import { Pencil, Power, Trash2 } from 'lucide-react';
import { cn } from '../../lib/cn';
import { deactivateResource, hardDeleteResource } from '../../app/resources/actions';
import type { ResourceListItem } from './types';

/**
 * Inline row-level controls for a resource: edit (opens form panel), soft
 * deactivate, and hard delete (with confirmation). All mutations are gated by
 * `canWrite` — read-only users see nothing.
 */
export function ResourceRowActions({
  resource,
  canWrite,
  onEdit,
}: {
  resource: ResourceListItem;
  canWrite: boolean;
  onEdit: (resource: ResourceListItem) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!canWrite) return null;

  function handleDeactivate() {
    setActionError(null);
    startTransition(async () => {
      const result = await deactivateResource(resource.id);
      if (!result.ok) setActionError(result.error);
    });
  }

  function handleHardDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setActionError(null);
    setConfirmDelete(false);
    startTransition(async () => {
      const result = await hardDeleteResource(resource.id);
      if (!result.ok) setActionError(result.error);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center justify-end gap-1">
        {/* Deactivate / re-activate */}
        {resource.isActive ? (
          <button
            type="button"
            disabled={isPending}
            onClick={handleDeactivate}
            title="Deactivate resource"
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-slate-100 disabled:opacity-50',
              'text-emerald-600',
            )}
          >
            <Power className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}

        {/* Edit */}
        <button
          type="button"
          onClick={() => onEdit(resource)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
          Edit
        </button>

        {/* Hard delete */}
        <button
          type="button"
          disabled={isPending}
          onClick={handleHardDelete}
          title={confirmDelete ? 'Click again to confirm permanent delete' : 'Permanently delete'}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-rose-50 disabled:opacity-50',
            confirmDelete ? 'text-rose-700 ring-1 ring-rose-300' : 'text-slate-400',
          )}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          {confirmDelete ? 'Confirm' : ''}
        </button>
      </div>

      {actionError ? (
        <p className="text-xs text-rose-600">{actionError}</p>
      ) : null}
    </div>
  );
}
