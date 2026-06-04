'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Date navigation shared by the manifest (single day) and calendar (week). It drives
 * the `?date=YYYY-MM-DD` query param via the router so the server component re-fetches
 * for the selected period. Prev/next step by `stepDays` (1 for the manifest, 7 for the
 * week calendar); "Today" jumps back to the current day.
 *
 * Dates are handled as plain YYYY-MM-DD strings to avoid timezone drift from Date
 * arithmetic — stepping adds/subtracts whole days on the calendar date itself.
 */
export interface DateNavProps {
  /** Currently selected date as YYYY-MM-DD. */
  date: string;
  /** Days to move per prev/next click (1 = day view, 7 = week view). */
  stepDays?: number;
  /** Human label for the current period, e.g. "Thu, Jun 4" or "Jun 2 – 8". */
  label: string;
  className?: string;
}

function shiftIsoDate(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  // Construct in UTC and step by days to avoid DST hour shifts; read back as date parts.
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + deltaDays);
  const yy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(base.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function todayIso(): string {
  const now = new Date();
  const yy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function DateNav({ date, stepDays = 1, label, className }: DateNavProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function go(nextDate: string) {
    const sp = new URLSearchParams(params.toString());
    sp.set('date', nextDate);
    router.push(`${pathname}?${sp.toString()}`);
  }

  const today = todayIso();
  const isToday = stepDays === 1 ? date === today : undefined;

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="flex items-center rounded-lg border border-slate-200 bg-white shadow-sm">
        <button
          type="button"
          aria-label="Previous"
          onClick={() => go(shiftIsoDate(date, -stepDays))}
          className="flex h-9 w-9 items-center justify-center rounded-l-lg text-slate-600 hover:bg-slate-100"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <div className="flex h-9 min-w-[9rem] items-center justify-center gap-2 border-x border-slate-200 px-3 text-sm font-medium text-slate-800">
          <CalendarDays className="h-4 w-4 text-slate-400" aria-hidden />
          <span className="truncate">{label}</span>
        </div>
        <button
          type="button"
          aria-label="Next"
          onClick={() => go(shiftIsoDate(date, stepDays))}
          className="flex h-9 w-9 items-center justify-center rounded-r-lg text-slate-600 hover:bg-slate-100"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <button
        type="button"
        onClick={() => go(today)}
        disabled={isToday}
        className={cn(
          'h-9 rounded-lg border px-3 text-sm font-medium shadow-sm transition-colors',
          isToday
            ? 'cursor-default border-slate-200 bg-slate-100 text-slate-400'
            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100',
        )}
      >
        Today
      </button>

      <input
        type="date"
        value={date}
        aria-label="Pick a date"
        onChange={(e) => {
          if (e.target.value) go(e.target.value);
        }}
        className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-700 shadow-sm focus:border-slate-400 focus:outline-none"
      />
    </div>
  );
}
