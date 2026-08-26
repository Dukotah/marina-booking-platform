'use client';

/**
 * Date picker for the customer booking portal.
 *
 * Two views over the same availability data:
 *   - a horizontal strip of the next 14 bookable days (the default, and the only
 *     one most mobile customers ever need)
 *   - the full colour-coded month grid, one tap away behind "More dates"
 *
 * Each day is coloured by the aggregate availability of the activity that day:
 *   - green  (AVAILABLE)   — comfortable capacity
 *   - yellow (FILLING_UP)  — filling up
 *   - red    (FULL)        — every slot full, or an operator blackout
 *   - neutral              — no bookable slots that day (past / closed)
 *
 * PERFORMANCE (see docs/PERFORMANCE.md). This component used to issue one HTTP
 * request per calendar day — up to 31 in parallel for a month. On rural cell that
 * is 5+ round-trip waves before a date can be picked, and the burst starves the
 * rest of the page. It now uses the API's `/api/availability/range` endpoint:
 * **one request covers every day it needs**, results are cached by day key for the
 * session, and a later month only fetches the days it is actually missing.
 *
 * All times are interpreted in the operator's local calendar (the API returns UTC
 * datetimes; days are keyed by their YYYY-MM-DD param).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addDays,
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  format,
  isBefore,
  isSameDay,
  isSameMonth,
  parseISO,
  startOfDay,
  startOfMonth,
} from 'date-fns';
import { DEMO_MODE } from '@/lib/demo/config';
import {
  getAvailability,
  isApiError,
  request,
  type AvailabilityDay,
  type SlotStatus,
} from '@/lib/api';

/** Aggregate availability for a single calendar day. */
export type DayAvailability = 'AVAILABLE' | 'FILLING_UP' | 'FULL' | 'NONE';

interface DayState {
  status: DayAvailability;
  /** Total remaining spots summed across the day's bookable slots. */
  spotsRemaining: number;
}

interface AvailabilityCalendarProps {
  activityId: string;
  /** Currently selected day, or null. Controlled by the parent. */
  selectedDate: Date | null;
  /** Fired when the customer picks a day that has bookable availability. */
  onSelectDate: (date: Date) => void;
  /** Optional cap on how far ahead a customer may book (days from today). */
  maxAdvanceDays?: number;
  /** Marker colour for the selected day. Defaults to the tenant brand colour. */
  accentColor?: string;
  /**
   * Select the soonest bookable day as soon as availability lands, so a
   * first-time mobile booking costs zero date taps. Off by default: controlled
   * callers that already have a date in mind (reschedule) must not be hijacked.
   */
  autoSelect?: boolean;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** How many days the fast-path strip offers before the month grid is needed. */
const STRIP_DAYS = 14;

const STATUS_RANK: Record<SlotStatus, number> = {
  AVAILABLE: 3,
  FILLING_UP: 2,
  FULL: 1,
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/** The per-day rollup shape returned by GET /api/availability/range. */
interface RangeDay {
  date: string;
  slotCount: number;
  capacityRemaining: number;
  signal: 'green' | 'yellow' | 'red';
}

function fromRangeDay(day: RangeDay): DayState {
  const spotsRemaining = Math.max(0, day.capacityRemaining);
  if (day.signal === 'green') return { status: 'AVAILABLE', spotsRemaining };
  if (day.signal === 'yellow') return { status: 'FILLING_UP', spotsRemaining };
  // Red means nothing is bookable: either every slot is full or there are no
  // slots at all (closed / blacked out). Only the former deserves the red cell.
  return { status: day.slotCount > 0 ? 'FULL' : 'NONE', spotsRemaining: 0 };
}

/** Collapse a day's slots into a single calendar status + spot count. */
function summarizeDay(day: AvailabilityDay): DayState {
  if (day.slots.length === 0) return { status: 'NONE', spotsRemaining: 0 };

  let best: SlotStatus = 'FULL';
  let spotsRemaining = 0;

  for (const slot of day.slots) {
    // Trust TRUE remaining capacity over the status label: a slot with no spots
    // left (e.g. exhausted by resource-booking overlaps) is effectively FULL even
    // if labelled AVAILABLE.
    const effectiveStatus: SlotStatus = slot.capacityRemaining <= 0 ? 'FULL' : slot.status;
    if (STATUS_RANK[effectiveStatus] > STATUS_RANK[best]) best = effectiveStatus;
    if (effectiveStatus !== 'FULL') spotsRemaining += Math.max(0, slot.capacityRemaining);
  }

  const status: DayAvailability =
    best === 'AVAILABLE' ? 'AVAILABLE' : best === 'FILLING_UP' ? 'FILLING_UP' : 'FULL';

  return { status, spotsRemaining };
}

/**
 * Fetch availability for an inclusive day range as a single request.
 *
 * Demo mode has no API to talk to, so it folds the in-memory per-day fixtures
 * into the same shape — free, because those are synchronous lookups.
 */
async function loadRange(
  activityId: string,
  fromIso: string,
  toIso: string,
  signal: AbortSignal,
): Promise<Array<[string, DayState]>> {
  if (DEMO_MODE) {
    const out: Array<[string, DayState]> = [];
    for (const d of eachDayOfInterval({ start: parseISO(fromIso), end: parseISO(toIso) })) {
      const iso = format(d, 'yyyy-MM-dd');
      try {
        out.push([iso, summarizeDay(await getAvailability(activityId, iso))]);
      } catch (err) {
        if (isApiError(err) && err.status === 404) {
          out.push([iso, { status: 'NONE', spotsRemaining: 0 }]);
        } else {
          throw err;
        }
      }
    }
    return out;
  }

  const qs = new URLSearchParams({ activityId, from: fromIso, to: toIso });
  const res = await request<{ days: RangeDay[] }>(
    `/api/availability/range?${qs.toString()}`,
    { signal },
  );
  return res.days.map((d) => [d.date, fromRangeDay(d)] as [string, DayState]);
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Tailwind classes for each availability state's month-grid cell. */
function cellClasses(status: DayAvailability, selected: boolean, disabled: boolean): string {
  const base =
    'relative flex aspect-square w-full flex-col items-center justify-center rounded-lg border text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1';

  if (selected) {
    return `${base} cursor-pointer border-slate-900 bg-slate-900 font-semibold text-white shadow-sm`;
  }
  if (disabled) {
    return `${base} cursor-not-allowed border-transparent text-slate-300`;
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

/** Spoken/label description of a day, identical in both views. */
function dayLabel(date: Date, state: DayState | undefined, unavailable: boolean): string {
  const when = format(date, 'EEEE, MMMM d');
  if (!state) return `${when} — checking availability`;
  if (unavailable) {
    return `${when} — ${state.status === 'FULL' ? 'fully booked' : 'unavailable'}`;
  }
  const n = state.spotsRemaining;
  return `${when} — ${n} ${n === 1 ? 'spot' : 'spots'} left`;
}

export function AvailabilityCalendar({
  activityId,
  selectedDate,
  onSelectDate,
  maxAdvanceDays = 365,
  accentColor = 'var(--brand-color)',
  autoSelect = false,
}: AvailabilityCalendarProps) {
  const today = useMemo(() => startOfDay(new Date()), []);
  // Bookable horizon (inclusive upper bound).
  const horizon = useMemo(() => startOfDay(addDays(today, maxAdvanceDays)), [today, maxAdvanceDays]);

  /** The fast-path days: today through today + STRIP_DAYS - 1, clipped to the horizon. */
  const stripDays = useMemo(() => {
    const wanted = addDays(today, STRIP_DAYS - 1);
    const end = isBefore(horizon, wanted) ? horizon : wanted;
    return isBefore(end, today) ? [today] : eachDayOfInterval({ start: today, end });
  }, [today, horizon]);

  // The grid starts open only when the controlled selection sits outside the
  // strip window (a reschedule of a far-future booking), so the selected day is
  // never invisible.
  const [showGrid, setShowGrid] = useState<boolean>(() => {
    if (!selectedDate) return false;
    const last = stripDays[stripDays.length - 1] as Date;
    return isBefore(last, startOfDay(selectedDate)) || isBefore(startOfDay(selectedDate), today);
  });
  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(selectedDate ?? today));
  const [days, setDays] = useState<Record<string, DayState>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Day keys already requested this session. Mutated synchronously so two effects
  // in the same tick (strip + month) can never fire overlapping requests, and so
  // paging back to a month is free.
  const requested = useRef<Set<string>>(new Set());
  const abort = useRef<AbortController | null>(null);
  const autoPicked = useRef(false);

  /**
   * Fetch every not-yet-requested day in [from, to] with a single range call.
   * Days already in flight or cached are skipped; the request spans the missing
   * days' outer bounds, which is still one round trip.
   */
  const ensureRange = useCallback(
    async (from: Date, to: Date) => {
      const start = isBefore(from, today) ? today : from;
      const end = isBefore(horizon, to) ? horizon : to;
      if (isBefore(end, start)) {
        setLoading(false);
        return;
      }

      const missing = eachDayOfInterval({ start, end })
        .map((d) => format(d, 'yyyy-MM-dd'))
        .filter((iso) => !requested.current.has(iso));

      if (missing.length === 0) {
        setLoading(false);
        return;
      }
      for (const iso of missing) requested.current.add(iso);

      const fromIso = missing[0] as string;
      const toIso = missing[missing.length - 1] as string;

      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;

      setLoading(true);
      setError(null);
      try {
        const results = await loadRange(activityId, fromIso, toIso, controller.signal);
        if (controller.signal.aborted) return;
        setDays((prev) => {
          const next = { ...prev };
          // Seed every requested day so a day the API omits reads as "closed"
          // rather than staying in the indefinite loading state.
          for (const iso of missing) next[iso] ??= { status: 'NONE', spotsRemaining: 0 };
          for (const [iso, state] of results) next[iso] = state;
          return next;
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        // Let a retry re-request these days.
        for (const iso of missing) requested.current.delete(iso);
        if (isApiError(err) && err.status === 404) {
          setDays((prev) => {
            const next = { ...prev };
            for (const iso of missing) next[iso] = { status: 'NONE', spotsRemaining: 0 };
            return next;
          });
        } else {
          setError('Could not load availability. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [activityId, today, horizon],
  );

  // Reset the cache when the activity changes (the reschedule dialog swaps it).
  const activityRef = useRef(activityId);
  if (activityRef.current !== activityId) {
    activityRef.current = activityId;
    requested.current = new Set();
    autoPicked.current = false;
  }

  // The strip is what the customer sees first, so it loads first and alone.
  useEffect(() => {
    setDays({});
    void ensureRange(stripDays[0] as Date, stripDays[stripDays.length - 1] as Date);
  }, [ensureRange, stripDays]);

  // The month grid only costs a request once the customer asks for it.
  useEffect(() => {
    if (!showGrid) return;
    void ensureRange(startOfMonth(viewMonth), endOfMonth(viewMonth));
  }, [showGrid, viewMonth, ensureRange]);

  useEffect(() => () => abort.current?.abort(), []);

  // Zero-tap date: once the strip's availability lands, land on the soonest day
  // that can actually be booked. Guarded so it happens at most once and never
  // overrides a selection the customer (or the caller) already made.
  useEffect(() => {
    if (!autoSelect || autoPicked.current || selectedDate || loading) return;
    for (const d of stripDays) {
      const state = days[format(d, 'yyyy-MM-dd')];
      if (state && (state.status === 'AVAILABLE' || state.status === 'FILLING_UP')) {
        autoPicked.current = true;
        onSelectDate(startOfDay(d));
        return;
      }
    }
  }, [autoSelect, selectedDate, loading, days, stripDays, onSelectDate]);

  const retry = () => {
    setError(null);
    void ensureRange(stripDays[0] as Date, stripDays[stripDays.length - 1] as Date);
    if (showGrid) void ensureRange(startOfMonth(viewMonth), endOfMonth(viewMonth));
  };

  const monthGrid = useMemo(() => {
    const monthStart = startOfMonth(viewMonth);
    const monthEnd = endOfMonth(viewMonth);
    return {
      allDays: eachDayOfInterval({ start: monthStart, end: monthEnd }),
      // Leading blanks so day 1 lands on the right weekday column.
      leading: monthStart.getDay(),
      monthStart,
    };
  }, [viewMonth]);

  const canGoPrev = useMemo(
    () => !isSameMonth(monthGrid.monthStart, today) && !isBefore(monthGrid.monthStart, today),
    [monthGrid.monthStart, today],
  );
  const canGoNext = useMemo(
    () =>
      isBefore(startOfMonth(addMonths(viewMonth, 1)), startOfMonth(horizon)) ||
      isSameMonth(addMonths(viewMonth, 1), horizon),
    [viewMonth, horizon],
  );

  /** Shared click handler: never advance on a day that cannot be booked. */
  const pick = (date: Date, disabled: boolean) => {
    if (disabled) return;
    autoPicked.current = true; // an explicit choice retires the auto-pick
    onSelectDate(startOfDay(date));
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
      {/* Fast path: the next two weeks, one horizontal flick. */}
      <div
        role="radiogroup"
        aria-label="Choose a date"
        aria-busy={loading}
        className="day-strip no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
      >
        {stripDays.map((date, i) => {
          const iso = format(date, 'yyyy-MM-dd');
          const state = days[iso];
          const status = state?.status ?? 'NONE';
          const disabled = !state || status === 'FULL' || status === 'NONE';
          const selected = selectedDate ? isSameDay(date, selectedDate) : false;

          return (
            <button
              key={iso}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={dayLabel(date, state, disabled)}
              disabled={disabled}
              onClick={() => pick(date, disabled)}
              className={[
                'flex min-h-[76px] w-[68px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl border-2 pt-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
                selected
                  ? 'border-slate-900 bg-slate-900 text-white shadow-sm'
                  : disabled
                    ? 'cursor-not-allowed border-slate-100 bg-white text-slate-300'
                    : status === 'FILLING_UP'
                      ? 'cursor-pointer border-amber-200 bg-amber-50 text-amber-900'
                      : 'cursor-pointer border-emerald-200 bg-emerald-50 text-emerald-900',
                !state && loading ? 'animate-pulse' : '',
              ].join(' ')}
            >
              <span aria-hidden className="text-[11px] font-medium uppercase tracking-wide opacity-70">
                {i === 0 ? 'Today' : i === 1 ? 'Tomo' : format(date, 'EEE')}
              </span>
              <span aria-hidden className="text-lg font-bold leading-none tabular-nums">
                {format(date, 'd')}
              </span>
              <span aria-hidden className="text-[10px] font-medium uppercase opacity-60">
                {format(date, 'MMM')}
              </span>
              {/* Fixed-height status rail: colour changes, geometry never does. */}
              <span
                aria-hidden
                className={`mt-1.5 h-1 w-full rounded-b-lg ${
                  selected ? '' : dotColor(status)
                }`}
                style={selected ? { backgroundColor: accentColor } : undefined}
              />
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setShowGrid((v) => !v)}
          aria-expanded={showGrid}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-slate-600 transition hover:text-slate-900"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          {showGrid ? 'Hide calendar' : 'More dates'}
        </button>
        {loading && (
          <span className="flex items-center gap-2 text-xs text-slate-400">
            <span
              aria-hidden
              className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
            />
            Checking availability…
          </span>
        )}
      </div>

      {showGrid && (
        <div className="mt-2 border-t border-slate-100 pt-3">
          {/* Month header + nav */}
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => canGoPrev && setViewMonth((m) => startOfMonth(addMonths(m, -1)))}
              disabled={!canGoPrev}
              aria-label="Previous month"
              className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <h3 className="text-sm font-semibold text-slate-900" aria-live="polite">
              {format(viewMonth, 'MMMM yyyy')}
            </h3>
            <button
              type="button"
              onClick={() => canGoNext && setViewMonth((m) => startOfMonth(addMonths(m, 1)))}
              disabled={!canGoNext}
              aria-label="Next month"
              className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30"
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
          <div className="grid grid-cols-7 gap-1" role="radiogroup" aria-label="Choose a date by month">
            {Array.from({ length: monthGrid.leading }).map((_, i) => (
              <div key={`blank-${i}`} aria-hidden />
            ))}

            {monthGrid.allDays.map((date) => {
              const iso = format(date, 'yyyy-MM-dd');
              const inPast = isBefore(date, today);
              const beyondHorizon = isBefore(horizon, date);
              const state = days[iso];
              const status: DayAvailability = state?.status ?? 'NONE';
              const disabled =
                inPast || beyondHorizon || !state || status === 'FULL' || status === 'NONE';
              const selected = selectedDate ? isSameDay(date, selectedDate) : false;
              const isToday = isSameDay(date, today);

              return (
                <button
                  key={iso}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  aria-label={dayLabel(date, state, disabled)}
                  onClick={() => pick(date, disabled)}
                  className={cellClasses(status, selected, disabled)}
                >
                  <span className={isToday && !selected ? 'underline decoration-2 underline-offset-2' : undefined}>
                    {format(date, 'd')}
                  </span>
                  {!selected && !disabled && (
                    <span aria-hidden className={`mt-0.5 h-1.5 w-1.5 rounded-full ${dotColor(status)}`} />
                  )}
                </button>
              );
            })}
          </div>

          {/* Legend — only meaningful once the colour-coded grid is on screen. */}
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
      )}

      {error && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <span role="alert">{error}</span>
          <button
            type="button"
            onClick={retry}
            className="ml-auto min-h-[36px] rounded-lg border border-rose-300 bg-white px-3 text-xs font-semibold text-rose-700 transition hover:bg-rose-100"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export default AvailabilityCalendar;
