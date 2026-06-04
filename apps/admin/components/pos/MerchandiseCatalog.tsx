'use client';

import { useMemo, useState } from 'react';
import { Search, Package, Plus } from 'lucide-react';
import { formatUSD } from '@marina/core';
import { cn } from '../../lib/cn';
import type { CartLine, PosMerchandise } from './types';

/**
 * Merchandise tab. A searchable grid of sellable items grouped by category. Tapping a
 * card adds one unit to the cart; out-of-stock items (tracked stock at zero) are
 * disabled so staff can't oversell physical inventory.
 */
export interface MerchandiseCatalogProps {
  items: PosMerchandise[];
  onAdd: (line: Omit<CartLine, 'key'>) => void;
}

export function MerchandiseCatalog({ items, onAdd }: MerchandiseCatalogProps) {
  const [query, setQuery] = useState('');

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? items.filter(
          (i) => i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q),
        )
      : items;
    const map = new Map<string, PosMerchandise[]>();
    for (const item of filtered) {
      const key = item.category || 'Other';
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items, query]);

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
        No merchandise yet. Add items under Settings to sell them at the register.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="relative w-full sm:w-80">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search merchandise…"
          aria-label="Search merchandise"
          className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
        />
      </div>

      {grouped.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          No items match “{query}”.
        </div>
      ) : (
        grouped.map(([category, group]) => (
          <div key={category}>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {category}
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {group.map((item) => {
                const outOfStock = item.onHandQty !== null && item.onHandQty <= 0;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={outOfStock}
                    onClick={() =>
                      onAdd({
                        kind: 'MERCHANDISE',
                        label: item.name,
                        sublabel: item.category,
                        unitPriceCents: item.priceCents,
                        quantity: 1,
                        merchandiseId: item.id,
                      })
                    }
                    className={cn(
                      'group flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-3 text-left transition-colors',
                      outOfStock
                        ? 'cursor-not-allowed opacity-60'
                        : 'hover:border-emerald-400 hover:bg-emerald-50',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <Package className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                        <span className="truncate text-sm font-medium text-slate-800">
                          {item.name}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {item.onHandQty === null
                          ? 'In stock'
                          : outOfStock
                            ? 'Out of stock'
                            : `${item.onHandQty} on hand`}
                      </span>
                    </span>
                    <span className="ml-2 flex shrink-0 items-center gap-1 font-semibold text-slate-900">
                      {formatUSD(item.priceCents)}
                      {!outOfStock ? (
                        <Plus
                          className="h-4 w-4 text-slate-300 transition-colors group-hover:text-emerald-600"
                          aria-hidden
                        />
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
