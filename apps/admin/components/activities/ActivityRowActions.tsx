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
        className="inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm font-medium text-ink-body hover:bg-surface-muted"
      >
        <Pencil className="h-4 w-4" aria-hidden />
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
          'inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-sm font-medium hover:bg-surface-muted disabled:opacity-50',
          visibleOnline ? 'text-emerald-600' : 'text-ink-muted',
        )}
      >
        {visibleOnline ? <Eye className="h-4 w-4" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />}
      </button>

      <button
        type="button"
        disabled={isPending}
        onClick={() => startTransition(() => void toggleActivityStatus(activityId))}
        title={status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
        className={cn(
          'inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-sm font-medium hover:bg-surface-muted disabled:opacity-50',
          status === 'ACTIVE' ? 'text-emerald-600' : 'text-ink-muted',
        )}
      >
        <Power className="h-4 w-4" aria-hidden />
      </button>

      <Link
        href={`/activities/${activityId}`}
        className="inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm font-medium text-ink-body hover:bg-surface-muted"
      >
        <Pencil className="h-4 w-4" aria-hidden />
        Edit
      </Link>
    </div>
  );
}
