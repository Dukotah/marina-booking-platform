'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../ui';

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
      <p className="text-sm text-ink-body tabular-nums">
        {total === 0 ? (
          'No orders'
        ) : (
          <>
            Showing <span className="font-medium text-ink">{firstShown}</span>–
            <span className="font-medium text-ink">{lastShown}</span> of{' '}
            <span className="font-medium text-ink">{total.toLocaleString('en-US')}</span>
          </>
        )}
      </p>

      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          onClick={() => goTo(safePage - 1)}
          disabled={!canPrev}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Prev
        </Button>
        <span className="px-1 text-sm text-ink-body tabular-nums">
          Page {safePage} of {totalPages}
        </span>
        <Button
          variant="secondary"
          onClick={() => goTo(safePage + 1)}
          disabled={!canNext}
          aria-label="Next page"
        >
          Next
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
