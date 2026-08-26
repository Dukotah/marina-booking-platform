'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface AuditPaginationProps {
  /** 1-based current page. */
  page: number;
  pageSize: number;
  /** Rows returned for this page — one more than pageSize means there is another. */
  returned: number;
}

/**
 * Pager for the audit timeline.
 *
 * Deliberately has no total count: the log grows without bound and a
 * `COUNT(*)` over a filtered range is the one query on this page that would not
 * stay fast. The server fetches pageSize + 1 rows and tells us whether the extra
 * one came back, which is all "is there a next page" needs.
 */
export function AuditPagination({ page, pageSize, returned }: AuditPaginationProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const hasNext = returned > pageSize;
  const shown = Math.min(returned, pageSize);
  const firstShown = shown === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = (page - 1) * pageSize + shown;

  function goTo(nextPage: number) {
    const params = new URLSearchParams(searchParams.toString());
    if (nextPage <= 1) params.delete('page');
    else params.set('page', String(nextPage));
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const canPrev = page > 1;

  if (!canPrev && !hasNext) {
    return null;
  }

  return (
    <div className="mt-4 flex items-center justify-between gap-4">
      <p className="text-sm text-slate-500">
        {shown === 0 ? (
          'No events'
        ) : (
          <>
            Showing <span className="font-medium text-slate-700">{firstShown}</span>–
            <span className="font-medium text-slate-700">{lastShown}</span>
          </>
        )}
      </p>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => goTo(page - 1)}
          disabled={!canPrev}
          aria-label="Newer events"
          className={cn(
            'inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700',
            canPrev ? 'hover:bg-slate-50' : 'cursor-not-allowed opacity-40',
          )}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Newer
        </button>
        <button
          type="button"
          onClick={() => goTo(page + 1)}
          disabled={!hasNext}
          aria-label="Older events"
          className={cn(
            'inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700',
            hasNext ? 'hover:bg-slate-50' : 'cursor-not-allowed opacity-40',
          )}
        >
          Older
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
