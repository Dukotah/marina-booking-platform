'use client';

/**
 * Client-side catalog browser: a search box plus category / capacity / price
 * filters over the activities fetched on the server. Filtering happens in the
 * browser against the already-loaded list, so it is instant and needs no extra
 * round-trips. Mobile-first: filters collapse into a compact toolbar that wraps.
 *
 * The parent server component passes the full catalog; this component owns only
 * the interactive filtering/search state. Money is integer cents throughout.
 */
import { useMemo, useState } from 'react';
import { formatUSD } from '@/lib/format';
import type { ActivityCategory, CatalogActivity } from '@/lib/api';
import { ActivityCard } from './ActivityCard';
import { categoryLabel, sortCategories } from './category';

interface CatalogBrowserProps {
  activities: CatalogActivity[];
}

type CategoryFilter = ActivityCategory | 'ALL';

/** Capacity buckets for the "group size" filter. */
const CAPACITY_OPTIONS = [
  { value: 0, label: 'Any size' },
  { value: 2, label: '2+' },
  { value: 6, label: '6+' },
  { value: 10, label: '10+' },
  { value: 20, label: '20+' },
] as const;

/** Upper price bounds in cents for the "max price" filter. */
const PRICE_OPTIONS = [
  { value: 0, label: 'Any price' },
  { value: 10000, label: `Under ${formatUSD(10000)}` },
  { value: 25000, label: `Under ${formatUSD(25000)}` },
  { value: 50000, label: `Under ${formatUSD(50000)}` },
  { value: 100000, label: `Under ${formatUSD(100000)}` },
] as const;

const SELECT_CLASS =
  'h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm outline-none transition focus:border-slate-300 focus:ring-2 focus:ring-[var(--brand-color)]';

export function CatalogBrowser({ activities }: CatalogBrowserProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('ALL');
  const [minCapacity, setMinCapacity] = useState(0);
  const [maxPrice, setMaxPrice] = useState(0);

  const categories = useMemo(
    () => sortCategories(Array.from(new Set(activities.map((a) => a.category)))),
    [activities],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return activities.filter((a) => {
      if (category !== 'ALL' && a.category !== category) return false;
      if (minCapacity > 0 && a.maxParticipants < minCapacity) return false;
      if (maxPrice > 0) {
        if (a.fromPriceCents == null || a.fromPriceCents > maxPrice) return false;
      }
      if (q && !a.name.toLowerCase().includes(q) && !categoryLabel(a.category).toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [activities, query, category, minCapacity, maxPrice]);

  const grouped = useMemo(() => {
    const map = new Map<ActivityCategory, CatalogActivity[]>();
    for (const a of filtered) {
      const list = map.get(a.category) ?? [];
      list.push(a);
      map.set(a.category, list);
    }
    return sortCategories(Array.from(map.keys())).map((cat) => ({
      category: cat,
      items: map.get(cat) as CatalogActivity[],
    }));
  }, [filtered]);

  const isFiltering =
    query.trim() !== '' || category !== 'ALL' || minCapacity > 0 || maxPrice > 0;

  function reset() {
    setQuery('');
    setCategory('ALL');
    setMinCapacity(0);
    setMaxPrice(0);
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="sticky top-16 z-30 -mx-4 mb-8 border-b border-slate-200 bg-slate-50/90 px-4 py-4 backdrop-blur">
        <div className="flex flex-col gap-3">
          {/* Search */}
          <div className="relative">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search activities..."
              aria-label="Search activities"
              className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-4 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-300 focus:ring-2 focus:ring-[var(--brand-color)]"
            />
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="filter-category">
              Category
            </label>
            <select
              id="filter-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as CategoryFilter)}
              className={SELECT_CLASS}
            >
              <option value="ALL">All categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {categoryLabel(cat)}
                </option>
              ))}
            </select>

            <label className="sr-only" htmlFor="filter-capacity">
              Group size
            </label>
            <select
              id="filter-capacity"
              value={minCapacity}
              onChange={(e) => setMinCapacity(Number(e.target.value))}
              className={SELECT_CLASS}
            >
              {CAPACITY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <label className="sr-only" htmlFor="filter-price">
              Max price
            </label>
            <select
              id="filter-price"
              value={maxPrice}
              onChange={(e) => setMaxPrice(Number(e.target.value))}
              className={SELECT_CLASS}
            >
              {PRICE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <span className="ml-auto text-sm text-slate-500">
              {filtered.length} {filtered.length === 1 ? 'result' : 'results'}
            </span>

            {isFiltering && (
              <button
                type="button"
                onClick={reset}
                className="rounded-lg px-3 text-sm font-medium text-slate-500 underline-offset-2 transition hover:text-slate-900 hover:underline"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Results */}
      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
          <p className="text-base font-semibold text-slate-900">No activities match your filters</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            Try a different search term, widen the group size, or raise the price limit.
          </p>
          <button
            type="button"
            onClick={reset}
            className="mt-5 inline-flex rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
            style={{ backgroundColor: 'var(--brand-color)' }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="space-y-12">
          {grouped.map((group) => (
            <section key={group.category}>
              <div className="mb-4 flex items-baseline justify-between">
                <h2 className="text-xl font-bold tracking-tight text-slate-900">
                  {categoryLabel(group.category)}
                </h2>
                <span className="text-sm text-slate-400">
                  {group.items.length} {group.items.length === 1 ? 'option' : 'options'}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {group.items.map((activity) => (
                  <ActivityCard key={activity.id} activity={activity} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export default CatalogBrowser;
