'use client';

import { useState, useTransition } from 'react';
import { Pause, Play, Trash2 } from 'lucide-react';
import { togglePromo, deletePromo, type ActionResult } from '../../app/promos/actions';

export interface PromoRowActionsProps {
  id: string;
  isActive: boolean;
  code: string;
}

/**
 * Row-level toggle (pause/resume) and delete for a promo code. Confirms before
 * deleting to avoid accidental removal of in-use codes.
 */
export function PromoRowActions({ id, isActive, code }: PromoRowActionsProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleToggle() {
    setMessage(null);
    startTransition(async () => {
      const result: ActionResult = await togglePromo(id, !isActive);
      if (!result.ok) setMessage(result.error ?? 'Error');
    });
  }

  function handleDelete() {
    if (!confirm(`Delete promo code "${code}"? This cannot be undone.`)) return;
    setMessage(null);
    startTransition(async () => {
      const result: ActionResult = await deletePromo(id);
      if (!result.ok) setMessage(result.error ?? 'Error');
    });
  }

  return (
    <div className="flex items-center justify-end gap-1">
      {message ? <span className="mr-2 text-xs text-rose-600">{message}</span> : null}
      <button
        type="button"
        disabled={isPending}
        onClick={handleToggle}
        title={isActive ? 'Pause' : 'Resume'}
        className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
      >
        {isActive ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
        <span className="sr-only">{isActive ? 'Pause' : 'Resume'}</span>
      </button>
      <button
        type="button"
        disabled={isPending}
        onClick={handleDelete}
        title="Delete"
        className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
        <span className="sr-only">Delete</span>
      </button>
    </div>
  );
}
