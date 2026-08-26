'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { CATEGORY_META, actionLabel, type AuditCategory } from './taxonomy';

export interface AuditFiltersProps {
  initialSearch: string;
  initialAction: string;
  initialCategory: string;
  initialFrom: string;
  initialTo: string;
  /** Actions that actually occur in this operator's log, with counts. */
  actionOptions: Array<{ action: string; count: number }>;
}

const CATEGORY_ORDER: AuditCategory[] = ['money', 'personal', 'access', 'config'];

/**
 * URL-driven filter bar for the audit log: category tabs (money / personal data
 * / access / settings), a specific action, an actor-or-entity search, and a date
 * range. Filters live in the query string so the server component re-runs the
 * tenant-scoped query — a filtered view is a shareable link, which is what an
 * auditor asking "show me every refund in March" actually wants.
 */
export function AuditFilters({
  initialSearch,
  initialAction,
  initialCategory,
  initialFrom,
  initialTo,
  actionOptions,
}: AuditFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(initialSearch);

  useEffect(() => {
    setSearch(initialSearch);
  }, [initialSearch]);

  const pushParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      params.delete('page'); // any filter change resets paging
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      });
    },
    [pathname, router, searchParams],
  );

  useEffect(() => {
    const handle = setTimeout(() => {
      if (search === initialSearch) return;
      pushParams((params) => {
        if (search.trim()) params.set('q', search.trim());
        else params.delete('q');
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [search, initialSearch, pushParams]);

  const hasFilters = Boolean(
    initialSearch || initialAction || initialCategory || initialFrom || initialTo,
  );

  function setCategory(next: string) {
    pushParams((params) => {
      if (next) params.set('category', next);
      else params.delete('category');
      // Category and a specific action are mutually exclusive views.
      params.delete('action');
    });
  }

  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <CategoryTab active={!initialCategory} label="Everything" onClick={() => setCategory('')} />
        {CATEGORY_ORDER.map((key) => (
          <CategoryTab
            key={key}
            active={initialCategory === key}
            label={CATEGORY_META[key].label}
            onClick={() => setCategory(key)}
          />
        ))}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            aria-hidden
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by actor or record id…"
            aria-label="Search audit events by actor or record id"
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-9 text-sm text-slate-700 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
          />
          {isPending ? (
            <span
              className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
              aria-hidden
            />
          ) : null}
        </div>

        <select
          value={initialAction}
          aria-label="Filter by action"
          onChange={(e) =>
            pushParams((params) => {
              if (e.target.value) params.set('action', e.target.value);
              else params.delete('action');
            })
          }
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
        >
          <option value="">All actions</option>
          {actionOptions.map((opt) => (
            <option key={opt.action} value={opt.action}>
              {actionLabel(opt.action)} ({opt.count.toLocaleString('en-US')})
            </option>
          ))}
        </select>

        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-500" htmlFor="audit-from">
            From
          </label>
          <input
            id="audit-from"
            type="date"
            value={initialFrom}
            max={initialTo || undefined}
            onChange={(e) =>
              pushParams((params) => {
                if (e.target.value) params.set('from', e.target.value);
                else params.delete('from');
              })
            }
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
          />
          <label className="text-sm text-slate-500" htmlFor="audit-to">
            To
          </label>
          <input
            id="audit-to"
            type="date"
            value={initialTo}
            min={initialFrom || undefined}
            onChange={(e) =>
              pushParams((params) => {
                if (e.target.value) params.set('to', e.target.value);
                else params.delete('to');
              })
            }
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
          />
        </div>

        {hasFilters ? (
          <button
            type="button"
            onClick={() =>
              pushParams((params) => {
                for (const key of ['q', 'action', 'category', 'from', 'to']) params.delete(key);
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
    </div>
  );
}

function CategoryTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full px-3 py-1.5 text-sm font-medium transition',
        active
          ? 'bg-slate-900 text-white'
          : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50',
      )}
    >
      {label}
    </button>
  );
}
