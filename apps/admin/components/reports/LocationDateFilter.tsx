'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@marina/ui';

export interface LocationDateFilterProps {
  from: string;
  to: string;
}

/** Local ISO date (YYYY-MM-DD) for a Date, no UTC shift. */
function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

const PRESETS: Array<{ label: string; range: () => { from: string; to: string } }> = [
  { label: 'Last 30 days', range: () => ({ from: isoDate(addDays(new Date(), -29)), to: isoDate(new Date()) }) },
  { label: 'Last 90 days', range: () => ({ from: isoDate(addDays(new Date(), -89)), to: isoDate(new Date()) }) },
  { label: 'Year to date', range: () => ({ from: isoDate(new Date(new Date().getFullYear(), 0, 1)), to: isoDate(new Date()) }) },
];

/**
 * Date-range filter for the multi-location roll-up. Routes to /reports/locations
 * with `from`/`to`, so the server component re-runs the tenant-scoped roll-up.
 */
export function LocationDateFilter({ from, to }: LocationDateFilterProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function apply(nextFrom: string, nextTo: string) {
    const params = new URLSearchParams({ from: nextFrom, to: nextTo });
    startTransition(() => router.push(`/reports/locations?${params.toString()}`));
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-body">
          From
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => e.target.value && apply(e.target.value, to)}
            className="h-11 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-body">
          To
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => e.target.value && apply(from, e.target.value)}
            className="h-11 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus"
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((preset) => {
          const r = preset.range();
          const isActive = r.from === from && r.to === to;
          return (
            <Button
              key={preset.label}
              type="button"
              size="sm"
              variant={isActive ? 'brand' : 'outline'}
              loading={isPending && isActive}
              onClick={() => apply(r.from, r.to)}
            >
              {preset.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
