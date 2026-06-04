'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { Eye, EyeOff, Pencil, Power } from 'lucide-react';
import { cn } from '../../lib/cn';
import { toggleActivityStatus, toggleActivityVisibility } from '../../app/activities/actions';

/**
 * Inline list-row controls: toggle active/inactive, toggle online visibility, and
 * an edit link. All mutations go through the `activity:write`-gated server actions
 * and revalidate the list. Buttons are optimistic-friendly via useTransition.
 */
export function ActivityRowActions({
  activityId,
  status,
  visibleOnline,
  canWrite,
}: {
  activityId: string;
  status: 'ACTIVE' | 'INACTIVE';
  visibleOnline: boolean;
  canWrite: boolean;
}) {
  const [isPending, startTransition] = useTransition();

  if (!canWrite) {
    return (
      <Link
        href={`/activities/${activityId}`}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden />
        View
      </Link>
    );
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <button
        type="button"
        disabled={isPending}
        onClick={() => startTransition(() => void toggleActivityVisibility(activityId, 'online'))}
        title={visibleOnline ? 'Hide from online booking' : 'Show online'}
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-slate-100 disabled:opacity-50',
          visibleOnline ? 'text-emerald-600' : 'text-slate-400',
        )}
      >
        {visibleOnline ? <Eye className="h-3.5 w-3.5" aria-hidden /> : <EyeOff className="h-3.5 w-3.5" aria-hidden />}
      </button>

      <button
        type="button"
        disabled={isPending}
        onClick={() => startTransition(() => void toggleActivityStatus(activityId))}
        title={status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-slate-100 disabled:opacity-50',
          status === 'ACTIVE' ? 'text-emerald-600' : 'text-slate-400',
        )}
      >
        <Power className="h-3.5 w-3.5" aria-hidden />
      </button>

      <Link
        href={`/activities/${activityId}`}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden />
        Edit
      </Link>
    </div>
  );
}
