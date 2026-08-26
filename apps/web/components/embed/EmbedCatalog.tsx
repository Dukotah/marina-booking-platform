'use client';

/**
 * Catalog step of the embedded widget.
 *
 * A widget sits in a narrow column on somebody else's page, so this is a leaner
 * frame than the full portal browser: instant search only, no filter rail. The
 * cards themselves are the portal's real `ActivityCard` — including its link to
 * `/activities/:id`, which the embed router translates into the activity step.
 */

import { useMemo, useState } from 'react';
import type { CatalogActivity } from '@/lib/api';
import { ActivityCard } from '@/components/catalog/ActivityCard';
import { categoryLabel } from '@/components/catalog/category';

interface EmbedCatalogProps {
  activities: CatalogActivity[];
  /** Operator (white-label) name for the intro line. */
  brandName: string;
}

/** Below this many options, a search box is more clutter than help. */
const SEARCH_THRESHOLD = 6;

export function EmbedCatalog({ activities, brandName }: EmbedCatalogProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return activities;
    return activities.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        categoryLabel(a.category).toLowerCase().includes(q),
    );
  }, [activities, query]);

  return (
    <div className="px-3 py-4">
      <div className="mb-4">
        <h1 className="text-lg font-bold tracking-tight text-slate-900">
          Book with {brandName}
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {activities.length} {activities.length === 1 ? 'experience' : 'experiences'} · live
          availability
        </p>
      </div>

      {activities.length > SEARCH_THRESHOLD && (
        <div className="relative mb-4">
          <svg
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
            placeholder="Search"
            aria-label="Search activities"
            className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-4 text-base text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-300 focus:ring-2 focus:ring-[var(--brand-color)]"
          />
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center">
          <p className="text-sm font-semibold text-slate-900">No matches</p>
          <button
            type="button"
            onClick={() => setQuery('')}
            className="mt-3 min-h-[44px] rounded-lg px-4 text-sm font-semibold text-white"
            style={{ backgroundColor: 'var(--brand-color)' }}
          >
            Show everything
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2">
          {filtered.map((activity) => (
            <ActivityCard key={activity.id} activity={activity} />
          ))}
        </div>
      )}
    </div>
  );
}

export default EmbedCatalog;
