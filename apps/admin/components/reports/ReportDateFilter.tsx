'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
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

  // --- Daily view: the "compile yesterday's sales" workflow. A single-day range
  //     (from === to) that steps a day at a time, with Today / Yesterday shortcuts. ---
  const today = isoDate(new Date());
  const yesterday = isoDate(addDays(new Date(), -1));
  const singleDay = from === to;

  function setDay(day: string) {
    apply(day, day);
  }
  function stepDay(delta: number) {
    const [y, m, d] = to.split('-').map((n) => parseInt(n, 10));
    const stepped = isoDate(addDays(new Date(y, m - 1, d), delta));
    apply(stepped, stepped);
  }
  function dayLabel(day: string): string {
    const [y, m, d] = day.split('-').map((n) => parseInt(n, 10));
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Daily stepper — step through single days for the daily report routine. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-md border border-slate-300 bg-white shadow-sm">
          <button
            type="button"
            onClick={() => stepDay(-1)}
            aria-label="Previous day"
            className="flex h-9 w-9 items-center justify-center rounded-l-md text-slate-600 hover:bg-slate-100"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <span className="flex h-9 min-w-[8.5rem] items-center justify-center border-x border-slate-200 px-3 text-sm font-medium text-slate-800">
            {singleDay ? dayLabel(to) : 'Custom range'}
          </span>
          <button
            type="button"
            onClick={() => stepDay(1)}
            aria-label="Next day"
            disabled={singleDay && to >= today}
            className="flex h-9 w-9 items-center justify-center rounded-r-md text-slate-600 hover:bg-slate-100 disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <Button
          type="button"
          size="sm"
          variant={singleDay && to === yesterday ? 'brand' : 'outline'}
          loading={isPending && singleDay && to === yesterday}
          onClick={() => setDay(yesterday)}
        >
          Yesterday
        </Button>
        <Button
          type="button"
          size="sm"
          variant={singleDay && to === today ? 'brand' : 'outline'}
          loading={isPending && singleDay && to === today}
          onClick={() => setDay(today)}
        >
          Today
        </Button>
      </div>

      {/* Broader ranges + a custom window. */}
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
    </div>
  );
}
