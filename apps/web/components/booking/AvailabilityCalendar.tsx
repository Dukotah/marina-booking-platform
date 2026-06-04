'use client';

/**
 * Color-coded month availability calendar for the customer booking portal.
 *
 * Renders a real calendar grid for a single month. Each day is colored by the
 * aggregate availability of the activity on that day:
 *   - green  (AVAILABLE)   — open capacity on at least one slot, none filling up
 *   - yellow (FILLING_UP)  — best remaining slot is filling up
 *   - red    (FULL)        — every slot is full
 *   - neutral              — no bookable slots that day (past / closed)
 *
 * Availability is fetched per-day, lazily, for the visible month via
 * getAvailability(activityId, isoDate) and cached in-component so navigating
 * back to a month doesn't refetch. Selecting an available day calls onSelectDate
 * so the parent can load the time-slot picker for that day.
 *
 * All times are interpreted in the operator's local calendar (the API returns
 * UTC datetimes; days are keyed by their YYYY-MM-DD param).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  format,
  isBefore,
  isSameDay,
  isSameMonth,
  startOfDay,
  startOfMonth,
} from 'date-fns';
import {
  getAvailability,
  isApiError,
  type AvailabilityDay,
  type SlotStatus,
} from '@/lib/api';

/** Aggregate availability for a single calendar day. */
export type DayAvailability = 'AVAILABLE' | 'FILLING_UP' | 'FULL' | 'NONE';

interface DayState {
  status: DayAvailability;
  /** Total remaining spots summed across the day's bookable slots. */
  spotsRemaining: number;
  /** Number of bookable (non-full) slots. */
  openSlots: number;
}

interface AvailabilityCalendarProps {
  activityId: string;
  /** Currently selected day, or null. Controlled by the parent. */
  selectedDate: Date | null;
  /** Fired when the customer picks a day that has bookable availability. */
  onSelectDate: (date: Date) => void;
  /** Optional cap on how far ahead a customer may book (days from today). */
  maxAdvanceDays?: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const STATUS_RANK: Record<SlotStatus, number> = {
  AVAILABLE: 3,
  FILLING_UP: 2,
  FULL: 1,
};

/** Collapse a day's slots into a single calendar status + spot count. */
function summarizeDay(day: AvailabilityDay): DayState {
  if (day.slots.length === 0) {
    return { status: 'NONE', spotsRemaining: 0, openSlots: 0 };
  }

  let best: SlotStatus = 'FULL';
  let spotsRemaining = 0;
  let openSlots = 0;

  for (const slot of day.slots) {
    if (STATUS_RANK[slot.status] > STATUS_RANK[best]) best = slot.status;
    if (slot.status !== 'FULL') {
      spotsRemaining += Math.max(0, slot.capacityRemaining);
      openSlots += 1;
    }
  }

  const status: DayAvailability =
    best === 'AVAILABLE' ? 'AVAILABLE' : best === 'FILLING_UP' ? 'FILLING_UP' : 'FULL';

  return { status, spotsRemaining, openSlots };
}

/** Tailwind classes for each availability state's day cell. */
function cellClasses(status: DayAvailability, selected: boolean, disabled: boolean): string {
  const base =
    'relative flex aspect-square w-full flex-col items-center justify-center rounded-lg border text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1';

  if (disabled) {
    return `${base} cursor-not-allowed border-transparent text-slate-300`;
  }
  if (selected) {
    return `${base} cursor-pointer border-slate-900 bg-slate-900 font-semibold text-white shadow-sm`;
  }
  switch (status) {
    case 'AVAILABLE':
      return `${base} cursor-pointer border-emerald-200 bg-emerald-50 font-medium text-emerald-900 hover:border-emerald-400 hover:bg-emerald-100`;
    case 'FILLING_UP':
      return `${base} cursor-pointer border-amber-200 bg-amber-50 font-medium text-amber-900 hover:border-amber-400 hover:bg-amber-100`;
    case 'FULL':
      return `${base} cursor-not-allowed border-rose-100 bg-rose-50 text-rose-400`;
    default:
      return `${base} cursor-not-allowed border-slate-100 bg-white text-slate-400`;
  }
}

function dotColor(status: DayAvailability): string {
  switch (status) {
    case 'AVAILABLE':
      return 'bg-emerald-500';
    case 'FILLING_UP':
      return 'bg-amber-500';
    case 'FULL':
      return 'bg-rose-400';
    default:
      return 'bg-transparent';
  }
}

export function AvailabilityCalendar({
  activityId,
  selectedDate,
  onSelectDate,
  maxAdvanceDays = 365,
}: AvailabilityCalendarProps) {
  const today = useMemo(() => startOfDay(new Date()), []);
  // Bookable horizon (inclusive upper bound).
  const horizon = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() + maxAdvanceDays);
    return startOfDay(d);
  }, [today, maxAdvanceDays]);

  const [viewMonth, setViewMonth] = useState<Date>(() =>
    startOfMonth(selectedDate ?? today),
  );
  // Cache day states keyed by YYYY-MM-DD across all months viewed this session.
  const [days, setDays] = useState<Record<string, DayState>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guard against out-of-order responses when the user pages quickly.
  const requestSeq = useRef(0);

  const monthGrid = useMemo(() => {
    const monthStart = startOfMonth(viewMonth);
    const monthEnd = endOfMonth(viewMonth);
    const allDays = eachDayOfInterval({ start: monthStart, end: monthEnd });
    // Leading blanks so day 1 lands on the right weekday column.
    const leading = monthStart.getDay();
    return { allDays, leading, monthStart, monthEnd };
  }, [viewMonth]);

  const loadMonth = useCallback(
    async (monthStart: Date) => {
      const monthEnd = endOfMonth(monthStart);
      // Only fetch in-range, not-yet-loaded days (skip past + beyond horizon).
      const toFetch = eachDayOfInterval({ start: monthStart, end: monthEnd }).filter(
        (d) => {
          if (isBefore(d, today)) return false;
          if (isBefore(horizon, d)) return false;
          return !(format(d, 'yyyy-MM-dd') in days);
        },
      );

      if (toFetch.length === 0) {
        setError(null);
        return;
      }

      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const results = await Promise.all(
          toFetch.map(async (d) => {
            const iso = format(d, 'yyyy-MM-dd');
            try {
              const day = await getAvailability(activityId, iso);
              return [iso, summarizeDay(day)] as const;
            } catch (err) {
              if (isApiError(err) && err.status === 404) {
                return [iso, { status: 'NONE', spotsRemaining: 0, openSlots: 0 }] as const;
              }
              throw err;
            }
          }),
        );
        if (seq !== requestSeq.current) return; // superseded
        setDays((prev) => {
          const next = { ...prev };
          for (const [iso, state] of results) next[iso] = state;
          return next;
        });
      } catch {
        if (seq !== requestSeq.current) return;
        setError('Could not load availability for this month. Please try again.');
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [activityId, days, today, horizon],
  );

  // Load whenever the viewed month changes. Reset cache when the activity changes.
  const activityRef = useRef(activityId);
  useEffect(() => {
    if (activityRef.current !== activityId) {
      activityRef.current = activityId;
      setDays({});
    }
    void loadMonth(startOfMonth(viewMonth));
    // loadMonth is intentionally not a dep target beyond month/activity to avoid
    // refetch loops from the `days` cache closure; it reads the latest cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMonth, activityId]);

  const canGoPrev = useMemo(
    () => !isSameMonth(monthGrid.monthStart, today) && !isBefore(monthGrid.monthStart, today),
    [monthGrid.monthStart, today],
  );
  const canGoNext = useMemo(
    () => isBefore(startOfMonth(addMonths(viewMonth, 1)), startOfMonth(horizon)) ||
      isSameMonth(addMonths(viewMonth, 1), horizon),
    [viewMonth, horizon],
  );

  const goPrev = () => {
    if (canGoPrev) setViewMonth((m) => startOfMonth(addMonths(m, -1)));
  };
  const goNext = () => {
    if (canGoNext) setViewMonth((m) => startOfMonth(addMonths(m, 1)));
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      {/* Month header + nav */}
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={goPrev}
          disabled={!canGoPrev}
          aria-label="Previous month"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-900">
            {format(viewMonth, 'MMMM yyyy')}
          </h3>
          {loading && (
            <span
              aria-hidden
              className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
            />
          )}
        </div>
        <button
          type="button"
          onClick={goNext}
          disabled={!canGoNext}
          aria-label="Next month"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      {/* Weekday header */}
      <div className="mb-1 grid grid-cols-7 gap-1">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="py-1 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-400"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: monthGrid.leading }).map((_, i) => (
          <div key={`blank-${i}`} aria-hidden />
        ))}

        {monthGrid.allDays.map((date) => {
          const iso = format(date, 'yyyy-MM-dd');
          const inPast = isBefore(date, today);
          const beyondHorizon = isBefore(horizon, date);
          const state = days[iso];
          const status: DayAvailability = state?.status ?? 'NONE';
          const isFull = status === 'FULL';
          const isNone = status === 'NONE';
          const disabled = inPast || beyondHorizon || isFull || isNone;
          const selected = selectedDate ? isSameDay(date, selectedDate) : false;
          const isToday = isSameDay(date, today);

          const spots = state?.spotsRemaining ?? 0;

          return (
            <button
              key={iso}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              aria-label={
                disabled
                  ? `${format(date, 'EEEE, MMMM d')} — ${isFull ? 'fully booked' : 'unavailable'}`
                  : `${format(date, 'EEEE, MMMM d')} — ${spots} ${spots === 1 ? 'spot' : 'spots'} left`
              }
              onClick={() => {
                if (!disabled) onSelectDate(startOfDay(date));
              }}
              className={cellClasses(status, selected, disabled)}
            >
              <span className={isToday && !selected ? 'underline decoration-2 underline-offset-2' : undefined}>
                {format(date, 'd')}
              </span>
              {!selected && !disabled && (
                <span
                  aria-hidden
                  className={`mt-0.5 h-1.5 w-1.5 rounded-full ${dotColor(status)}`}
                />
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </p>
      )}

      {/* Legend */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" aria-hidden />
          Available
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500" aria-hidden />
          Filling up
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400" aria-hidden />
          Full
        </span>
      </div>
    </div>
  );
}

export default AvailabilityCalendar;
