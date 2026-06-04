'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * URL-driven pager for the orders list. Page number lives in the `page` query
 * param so the server component re-runs its scoped query for the right window.
 */
export function OrdersPagination({
  page,
  pageSize,
  total,
}: {
  /** 1-based current page. */
  page: number;
  pageSize: number;
  total: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const firstShown = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const lastShown = Math.min(safePage * pageSize, total);

  function goTo(nextPage: number) {
    const params = new URLSearchParams(searchParams.toString());
    if (nextPage <= 1) params.delete('page');
    else params.set('page', String(nextPage));
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const canPrev = safePage > 1;
  const canNext = safePage < totalPages;

  return (
    <div className="mt-4 flex items-center justify-between gap-4">
      <p className="text-sm text-slate-500">
        {total === 0 ? (
          'No orders'
        ) : (
          <>
            Showing <span className="font-medium text-slate-700">{firstShown}</span>–
            <span className="font-medium text-slate-700">{lastShown}</span> of{' '}
            <span className="font-medium text-slate-700">{total.toLocaleString('en-US')}</span>
          </>
        )}
      </p>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => goTo(safePage - 1)}
          disabled={!canPrev}
          aria-label="Previous page"
          className={cn(
            'inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700',
            canPrev ? 'hover:bg-slate-50' : 'cursor-not-allowed opacity-40',
          )}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Prev
        </button>
        <span className="px-2 text-sm text-slate-500">
          Page {safePage} of {totalPages}
        </span>
        <button
          type="button"
          onClick={() => goTo(safePage + 1)}
          disabled={!canNext}
          aria-label="Next page"
          className={cn(
            'inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700',
            canNext ? 'hover:bg-slate-50' : 'cursor-not-allowed opacity-40',
          )}
        >
          Next
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
