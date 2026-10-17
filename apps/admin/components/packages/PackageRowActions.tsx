'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { Pencil, Trash2 } from 'lucide-react';
import { cn } from '../../lib/cn';
import { deletePackage } from '../../app/catalog/packages/actions';

/**
 * Inline list-row controls for a package: edit link + delete. Delete is gated on
 * the same `activity:write` permission server-side and revalidates the list.
 */
export function PackageRowActions({
  packageId,
  name,
  canWrite,
}: {
  packageId: string;
  name: string;
  canWrite: boolean;
}) {
  const [pending, startTransition] = useTransition();

  if (!canWrite) {
    return <span className="text-sm text-ink-muted">—</span>;
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <Link
        href={`/catalog/packages/${packageId}`}
        className="inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm font-medium text-ink-body hover:bg-surface-muted"
      >
        <Pencil className="h-4 w-4" aria-hidden />
        Edit
      </Link>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`Delete package “${name}”? This can't be undone.`)) return;
          startTransition(() => void deletePackage(packageId));
        }}
        title="Delete package"
        className={cn(
          'inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-sm font-medium text-rose-600 hover:bg-surface-muted disabled:opacity-50',
        )}
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
