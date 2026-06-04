'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { OrderStatusValue } from './OrderStatusBadge';

const STATUS_OPTIONS: Array<{ value: '' | OrderStatusValue; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'UPCOMING', label: 'Upcoming' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'NO_SHOW', label: 'No-show' },
];

/**
 * URL-driven filter bar for the orders list: free-text search (order #, customer
 * name/email), status, and booking date. Writing to the URL keeps the list a
 * server component (filters re-run the server query) and makes views shareable.
 * Search is debounced so typing doesn't fire a request per keystroke.
 */
export function OrdersFilters({
  initialSearch,
  initialStatus,
  initialDate,
}: {
  initialSearch: string;
  initialStatus: string;
  initialDate: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [search, setSearch] = useState(initialSearch);

  // Keep local input in sync if the URL changes externally (e.g. clear button).
  useEffect(() => {
    setSearch(initialSearch);
  }, [initialSearch]);

  const pushParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      // Any filter change resets pagination to the first page.
      params.delete('page');
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      });
    },
    [pathname, router, searchParams],
  );

  // Debounce search input → URL.
  useEffect(() => {
    const handle = setTimeout(() => {
      if (search === initialSearch) return;
      pushParams((params) => {
        if (search.trim()) params.set('search', search.trim());
        else params.delete('search');
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [search, initialSearch, pushParams]);

  const hasFilters = Boolean(initialSearch || initialStatus || initialDate);

  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="relative min-w-0 flex-1 sm:max-w-xs">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          aria-hidden
        />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search order #, name, email…"
          aria-label="Search orders"
          className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
        />
      </div>

      <select
        value={initialStatus}
        aria-label="Filter by status"
        onChange={(e) =>
          pushParams((params) => {
            if (e.target.value) params.set('status', e.target.value);
            else params.delete('status');
          })
        }
        className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
      >
        {STATUS_OPTIONS.map((opt) => (
          <option key={opt.value || 'all'} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      <input
        type="date"
        value={initialDate}
        aria-label="Filter by booking date"
        onChange={(e) =>
          pushParams((params) => {
            if (e.target.value) params.set('date', e.target.value);
            else params.delete('date');
          })
        }
        className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
      />

      {hasFilters ? (
        <button
          type="button"
          onClick={() =>
            pushParams((params) => {
              params.delete('search');
              params.delete('status');
              params.delete('date');
            })
          }
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-500',
            'hover:bg-slate-100 hover:text-slate-700',
          )}
        >
          <X className="h-4 w-4" aria-hidden />
          Clear
        </button>
      ) : null}
    </div>
  );
}
