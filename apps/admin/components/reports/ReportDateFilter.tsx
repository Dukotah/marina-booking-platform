'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@marina/ui';

export interface ReportDateFilterProps {
  /** Current resolved range (ISO YYYY-MM-DD). */
  from: string;
  to: string;
  /** Current report kind, preserved across range changes. */
  reportKind: string;
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

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

interface Preset {
  label: string;
  range: () => { from: string; to: string };
}

const PRESETS: Preset[] = [
  {
    label: 'Last 7 days',
    range: () => {
      const today = new Date();
      return { from: isoDate(addDays(today, -6)), to: isoDate(today) };
    },
  },
  {
    label: 'Last 30 days',
    range: () => {
      const today = new Date();
      return { from: isoDate(addDays(today, -29)), to: isoDate(today) };
    },
  },
  {
    label: 'This month',
    range: () => {
      const today = new Date();
      return { from: isoDate(startOfMonth(today)), to: isoDate(today) };
    },
  },
  {
    label: 'Last 90 days',
    range: () => {
      const today = new Date();
      return { from: isoDate(addDays(today, -89)), to: isoDate(today) };
    },
  },
];

/**
 * Date-range filter for reports. Writes `from`/`to` (and preserves `report`) to
 * the URL search params, so the server component re-runs the tenant-scoped query
 * for the new window. Quick presets cover the common operator windows; the two
 * date inputs allow any custom range.
 */
export function ReportDateFilter({ from, to, reportKind }: ReportDateFilterProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function apply(nextFrom: string, nextTo: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('from', nextFrom);
    params.set('to', nextTo);
    if (reportKind) params.set('report', reportKind);
    startTransition(() => {
      router.push(`/reports?${params.toString()}`);
    });
  }

  const activePreset = PRESETS.find((p) => {
    const r = p.range();
    return r.from === from && r.to === to;
  });

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
          From
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => e.target.value && apply(e.target.value, to)}
            className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-[var(--brand-color,#0ea5e9)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
          To
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => e.target.value && apply(from, e.target.value)}
            className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-[var(--brand-color,#0ea5e9)]"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((preset) => {
          const isActive = preset === activePreset;
          return (
            <Button
              key={preset.label}
              type="button"
              size="sm"
              variant={isActive ? 'brand' : 'outline'}
              loading={isPending && isActive}
              onClick={() => {
                const r = preset.range();
                apply(r.from, r.to);
              }}
            >
              {preset.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
