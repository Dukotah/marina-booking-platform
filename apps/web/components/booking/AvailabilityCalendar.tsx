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
 * CORRECTNESS. The one state this component may never rest in is "this day is
 * unknown and nothing is going to find out" — a day with no answer renders
 * disabled and unbookable, which is lost revenue that looks like a slow network.
 * Two rules keep that unreachable, and every change here has to preserve both:
 *
 *   1. `requested` is a reservation, not a receipt. A request that does not deliver
 *      its days (abort, network failure) gives them back, and asks the reconcile
 *      effect to run again.
 *   2. Requests are additive. Nothing aborts a sibling range to make room for
 *      itself; the only aborts are unmount and an activity swap, both of which
 *      throw the whole cache away anyway.
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
  /**
   * Availability for the strip window, fetched on the SERVER and rendered with the
   * page. Without it the first thing a guest sees is a row of disabled days reading
   * "checking availability" while the browser makes its own round trip — which on the
   * weak rural connection this product targets is several seconds of a screen that
   * cannot be used. Seeding it means the dates arrive already tappable.
   */
  initialRange?: RangeDay[];
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
export interface RangeDay {
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
function dayLabel(
  date: Date,
  state: DayState | undefined,
  unavailable: boolean,
  failed: boolean,
): string {
  const when = format(date, 'EEEE, MMMM d');
  // A day with no answer only says "checking" while something is actually going to
  // answer it. Once the load has failed, say so — the promise of a result that is
  // never coming is worse than the bad news, and the retry sits right below.
  if (!state) {
    return failed ? `${when} — availability unavailable` : `${when} — checking availability`;
  }
  if (unavailable) {
    return `${when} — ${state.status === 'FULL' ? 'fully booked' : 'unavailable'}`;
  }
  const n = state.spotsRemaining;
  return `${when} — ${n} ${n === 1 ? 'spot' : 'spots'} left`;
}

// ---------------------------------------------------------------------------
// Radiogroup keyboard semantics
// ---------------------------------------------------------------------------

/*
 * `role="radio"` promises two things, and this component only ever kept one of them.
 * A screen reader announces "radio button, 3 of 14" and its user reaches for an arrow
 * key; nothing answered, so the strip behaved like fourteen unrelated buttons — and
 * fourteen tab stops (thirty-one more with the month grid open) sat between the rate
 * and the time for anyone driving the booking from a keyboard. The two functions below
 * are the WAI-ARIA radiogroup pattern: one tab stop for the whole group, arrows to move
 * inside it.
 */

/**
 * The option that owns the group's single tab stop.
 *
 * The checked one, normally. When nothing is checked — or the checked day is no longer
 * selectable, which happens the moment a day sells out under a guest — the first day
 * that CAN be picked takes it, so Tab always lands somewhere that does something. -1
 * when no day is selectable at all, which leaves the group out of the tab order rather
 * than parking focus on a dead control.
 */
function rovingIndex(selectable: boolean[], selectedIndex: number): number {
  if (selectedIndex >= 0 && selectable[selectedIndex]) return selectedIndex;
  return selectable.indexOf(true);
}

/**
 * The next selectable option `step` positions away, wrapping, or -1 if there is none.
 *
 * Unselectable days are stepped over rather than landed on: a sold-out day is not a
 * choice, and focusing one would strand the arrow keys on a disabled button. `step` is
 * ±1 along the strip and ±7 in the month grid, where it walks the same weekday column.
 */
function nextSelectableIndex(selectable: boolean[], from: number, step: number): number {
  const n = selectable.length;
  if (n === 0 || step === 0) return -1;
  for (let hop = 1; hop <= n; hop++) {
    const candidate = (((from + step * hop) % n) + n) % n;
    if (selectable[candidate]) return candidate;
  }
  return -1;
}

export function AvailabilityCalendar({
  activityId,
  selectedDate,
  onSelectDate,
  maxAdvanceDays = 365,
  accentColor = 'var(--brand-color)',
  autoSelect = false,
  initialRange,
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
  // Seeded from the server render when available, so the strip is interactive on
  // first paint instead of after a client round trip.
  const [days, setDays] = useState<Record<string, DayState>>(() =>
    Object.fromEntries((initialRange ?? []).map((d) => [d.date, fromRangeDay(d)])),
  );
  const [error, setError] = useState<string | null>(null);
  // How many range requests are out. A count, not a boolean: the strip and the month
  // grid load independently, and whichever lands first must not clear the other's
  // spinner.
  const [pending, setPending] = useState(0);
  // Bumped whenever a request hands its days back without having delivered them, so
  // the reconcile effect below asks for them again. See ensureRange's catch.
  const [reconcileTick, setReconcileTick] = useState(0);

  // Day keys already loaded or in flight. Mutated synchronously so two ensureRange
  // calls in the same tick (strip + month) ask for disjoint sets instead of
  // duplicating each other, and so paging back to a month already seen is free.
  // Server-seeded days count as already requested, so the reconcile effect does not
  // immediately re-fetch what the page already delivered.
  const requested = useRef<Set<string>>(new Set((initialRange ?? []).map((d) => d.date)));
  // Every live request, so unmount can cancel them. Nothing else aborts.
  const inFlight = useRef<Set<AbortController>>(new Set());
  // Incremented whenever the cache is thrown away. A response from an older epoch is
  // the answer to a question about an activity this calendar no longer shows, and its
  // reservations died with the cache, so it must touch neither.
  const epoch = useRef(0);
  const autoPicked = useRef(false);

  // Swapping the activity (the reschedule dialog does, when the order has more than
  // one item) invalidates everything. This is React's supported "adjust state when a
  // prop changes" pattern — done during render so the previous activity's colours
  // never paint, instead of flashing for a frame before an effect clears them.
  const [activityKey, setActivityKey] = useState(activityId);
  if (activityKey !== activityId) {
    setActivityKey(activityId);
    epoch.current += 1;
    requested.current = new Set();
    autoPicked.current = false;
    for (const controller of inFlight.current) controller.abort();
    inFlight.current.clear();
    setDays({});
    setError(null);
    // `pending` is deliberately left alone: the requests just aborted still run their
    // own finally and decrement it themselves.
  }

  /**
   * Fetch every not-yet-requested day in [from, to] with a single range call.
   * Days already in flight or cached are skipped; the request spans the missing
   * days' outer bounds, which is still one round trip.
   *
   * Safe to call at any time with any range — that is the property the reconcile
   * effect relies on to recover from an abort.
   */
  const ensureRange = useCallback(
    async (from: Date, to: Date) => {
      const start = isBefore(from, today) ? today : from;
      const end = isBefore(horizon, to) ? horizon : to;
      if (isBefore(end, start)) return;

      const missing = eachDayOfInterval({ start, end })
        .map((d) => format(d, 'yyyy-MM-dd'))
        .filter((iso) => !requested.current.has(iso));
      if (missing.length === 0) return;

      // Reserve before the first await, so a sibling call in this same tick sees them.
      for (const iso of missing) requested.current.add(iso);

      const fromIso = missing[0] as string;
      const toIso = missing[missing.length - 1] as string;

      const generation = epoch.current;
      const controller = new AbortController();
      inFlight.current.add(controller);

      setPending((n) => n + 1);
      setError(null);
      try {
        const results = await loadRange(activityId, fromIso, toIso, controller.signal);
        // Only a cache invalidation can make this response worthless. A response that
        // merely arrived after an abort is still true, and a StrictMode remount is
        // still the same mounted component, so it is applied rather than discarded.
        if (epoch.current !== generation) return;
        setDays((prev) => {
          const next = { ...prev };
          // Seed every requested day so a day the API omits reads as "closed"
          // rather than staying in the indefinite loading state.
          for (const iso of missing) next[iso] ??= { status: 'NONE', spotsRemaining: 0 };
          for (const [iso, state] of results) next[iso] = state;
          return next;
        });
      } catch (err) {
        if (epoch.current !== generation) return;

        if (isApiError(err) && err.status === 404) {
          // A 404 is an answer, not a failure: nothing is published across this range.
          // The days keep their reservation because they are now resolved.
          setDays((prev) => {
            const next = { ...prev };
            for (const iso of missing) next[iso] = { status: 'NONE', spotsRemaining: 0 };
            return next;
          });
          return;
        }

        // Nothing was delivered, so the reservation goes back. `requested` exists only
        // to stop duplicate in-flight requests; holding days a failed request never
        // filled means nothing ever asks again and they sit on "checking availability"
        // forever — disabled, unbookable, indistinguishable from a sold-out day.
        for (const iso of missing) requested.current.delete(iso);

        if (controller.signal.aborted) {
          // WE cancelled this (unmount), so it is not a customer-visible error. But
          // releasing the days is not enough on its own: React StrictMode tears down
          // and re-mounts synchronously, so the remount's reconcile has ALREADY run and
          // found nothing missing by the time this rejection lands a microtask later.
          // That is the race — the days were freed with nobody left to ask for them.
          // Bumping the tick re-runs the reconcile now that they are free. If this was
          // a real unmount, the update is dropped and none of it matters.
          setReconcileTick((t) => t + 1);
          return;
        }

        setError('Could not load availability. Check your connection and try again.');
      } finally {
        inFlight.current.delete(controller);
        setPending((n) => Math.max(0, n - 1));
      }
    },
    [activityId, today, horizon],
  );

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

  /**
   * Is any day the customer can currently see still without an answer?
   *
   * Days outside [today, horizon] are excluded: they are never fetched and never
   * bookable, so waiting on them would spin forever.
   */
  const unknownVisible = useMemo(() => {
    const visible = showGrid ? [...stripDays, ...monthGrid.allDays] : stripDays;
    return visible.some((d) => {
      if (isBefore(d, today) || isBefore(horizon, d)) return false;
      return days[format(d, 'yyyy-MM-dd')] === undefined;
    });
  }, [showGrid, stripDays, monthGrid.allDays, today, horizon, days]);

  // Loading is derived, never a latch that someone has to remember to clear. It holds
  // the invariant this component exists to keep: a visible day is either answered, or
  // being fetched, or covered by an error the customer can retry — never simply
  // unknown and idle.
  const loading = pending > 0 || (error === null && unknownVisible);
  const loadFailed = error !== null;

  // One effect decides what has to be on screen: the strip always, plus the open
  // month. Re-running it is always safe — ensureRange only asks for days that are
  // neither cached nor in flight — and that is exactly what makes recovery from an
  // abort or a retry a matter of running it again.
  useEffect(() => {
    void ensureRange(stripDays[0] as Date, stripDays[stripDays.length - 1] as Date);
    if (showGrid) void ensureRange(startOfMonth(viewMonth), endOfMonth(viewMonth));
  }, [ensureRange, stripDays, showGrid, viewMonth, reconcileTick]);

  // Abort only on the way out. A live request is never cancelled to make room for
  // another range: the two ranges are additive, and cancelling one used to throw its
  // days away — the strip lost its whole fortnight whenever the grid opened first.
  useEffect(() => {
    const live = inFlight.current;
    return () => {
      for (const controller of live) controller.abort();
      live.clear();
    };
  }, []);

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

  // Clearing the error is enough to make the days askable again — the failed request
  // already gave its reservation back — so the tick just re-runs the reconcile, which
  // covers the strip and the open month in one place.
  const retry = () => {
    setError(null);
    setReconcileTick((t) => t + 1);
  };

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

  // Selectability is derived once and read by BOTH the render and the arrow keys.
  // Deriving it twice is how a keyboard walk drifts out of step with what is on
  // screen — the arrows would happily land on a day the render had disabled.
  const stripSelectable = useMemo(
    () =>
      stripDays.map((date) => {
        const state = days[format(date, 'yyyy-MM-dd')];
        return Boolean(state) && state?.status !== 'FULL' && state?.status !== 'NONE';
      }),
    [stripDays, days],
  );

  const gridSelectable = useMemo(
    () =>
      monthGrid.allDays.map((date) => {
        if (isBefore(date, today) || isBefore(horizon, date)) return false;
        const state = days[format(date, 'yyyy-MM-dd')];
        return Boolean(state) && state?.status !== 'FULL' && state?.status !== 'NONE';
      }),
    [monthGrid.allDays, today, horizon, days],
  );

  const stripSelectedIndex = selectedDate
    ? stripDays.findIndex((d) => isSameDay(d, selectedDate))
    : -1;
  const gridSelectedIndex = selectedDate
    ? monthGrid.allDays.findIndex((d) => isSameDay(d, selectedDate))
    : -1;

  /*
   * The arrow keys here MOVE FOCUS WITHOUT SELECTING; Space or Enter chooses the day.
   *
   * That is the deliberate exception to "selection follows focus", which is what a
   * native radio group does and what the rate cards and the time chips do. Choosing a
   * day is not free the way choosing a rate is: it discards the time the guest already
   * picked and sends the time picker back to the network for that day's slots. Arrowing
   * across a fortnight would be fourteen round trips on precisely the rural connection
   * this product is built for. So the group announces "not checked" as focus passes,
   * and the guest commits with Space — the documented alternative for a radiogroup
   * whose selection has side effects.
   *
   * Because selection no longer follows focus, the tab stop has to follow focus
   * instead: without this, tabbing out of the strip and back would drop the guest on
   * the checked day rather than the one they had arrowed to.
   */
  const [stripFocusIndex, setStripFocusIndex] = useState(-1);
  const [gridFocusIndex, setGridFocusIndex] = useState(-1);

  const stripTabStop =
    stripFocusIndex >= 0 && stripSelectable[stripFocusIndex]
      ? stripFocusIndex
      : rovingIndex(stripSelectable, stripSelectedIndex);
  const gridTabStop =
    gridFocusIndex >= 0 && gridSelectable[gridFocusIndex]
      ? gridFocusIndex
      : rovingIndex(gridSelectable, gridSelectedIndex);

  const stripRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const gridRefs = useRef<Array<HTMLButtonElement | null>>([]);

  /** Move focus within one of the two day groups, stepping over unbookable days. */
  const moveWithin = (which: 'strip' | 'grid', from: number, step: number) => {
    const selectable = which === 'strip' ? stripSelectable : gridSelectable;
    const refs = which === 'strip' ? stripRefs : gridRefs;

    const to = nextSelectableIndex(selectable, from, step);
    if (to < 0) return;
    refs.current[to]?.focus();
  };

  /** Arrow / Home / End for a day group. `rowStep` is 1 on the strip, 7 in the grid. */
  const dayKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    which: 'strip' | 'grid',
    index: number,
    rowStep: number,
  ) => {
    const count = (which === 'strip' ? stripSelectable : gridSelectable).length;
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        moveWithin(which, index, 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        moveWithin(which, index, -1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveWithin(which, index, rowStep);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveWithin(which, index, -rowStep);
        break;
      case 'Home':
        // Search forward from before the first option, so Home lands on the first
        // BOOKABLE day rather than on whatever happens to sit at index 0.
        event.preventDefault();
        moveWithin(which, -1, 1);
        break;
      case 'End':
        event.preventDefault();
        moveWithin(which, count, -1);
        break;
      default:
        break;
    }
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
          const disabled = !stripSelectable[i];
          const selected = selectedDate ? isSameDay(date, selectedDate) : false;

          return (
            <button
              key={iso}
              ref={(node) => {
                stripRefs.current[i] = node;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={dayLabel(date, state, disabled, loadFailed)}
              disabled={disabled}
              // One tab stop for the whole strip; the arrows do the rest.
              tabIndex={i === stripTabStop ? 0 : -1}
              onFocus={() => setStripFocusIndex(i)}
              onClick={() => pick(date, disabled)}
              onKeyDown={(event) => dayKeyDown(event, 'strip', i, 1)}
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
              <span
                aria-hidden
                // Was opacity-70, which multiplies against whatever tint the day
                // chip is painted and lands at 4.15:1 on the available-day green.
                // Opacity is invisible to a design token, so the weight is carried
                // by the type instead and the colour stays at full strength.
                className="text-[11px] font-semibold uppercase tracking-wide"
              >
                {i === 0 ? 'Today' : i === 1 ? 'Tomo' : format(date, 'EEE')}
              </span>
              <span aria-hidden className="text-lg font-bold leading-none tabular-nums">
                {format(date, 'd')}
              </span>
              <span
                aria-hidden
                // Same reason as the label above: opacity multiplies against the day
                // chip's tint and lands at 3.27:1 on the available-day green. At 10px
                // this is the smallest text in the funnel, so it needs the full 4.5:1.
                className="text-[10px] font-semibold uppercase"
              >
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
        {/*
          4.1.3 Status Messages. The strip used to announce its loading state only
          through the day buttons themselves — fourteen DISABLED controls whose names
          silently changed from "checking availability" to a spot count under the
          guest. A disabled control is not where a screen reader is waiting, and a name
          that mutates in place is not an announcement. This region carries it instead.

          It is rendered from the first paint and only its TEXT changes: a live region
          inserted into the DOM at the same moment as its message is not reliably
          announced at all, so the region has to outlive the state it reports. The day
          names are left exactly as they were — they answer "what is this?" for anyone
          who does reach one mid-load, which is a different question.
        */}
        <span role="status" className="flex items-center gap-2 text-xs text-slate-400">
          {loading ? (
            <>
              <span
                aria-hidden
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
              />
              Checking availability…
            </>
          ) : loadFailed ? null : (
            // Silence after "checking availability…" reads as a page that gave up.
            // Visually hidden on purpose: the spinner vanishing is the sighted
            // equivalent, and visible text here would be new UI rather than a fix.
            <span className="sr-only">Availability updated. Dates are ready to choose.</span>
          )}
        </span>
      </div>

      {showGrid && (
        <div className="mt-2 border-t border-slate-100 pt-3">
          {/* Month header + nav */}
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                if (!canGoPrev) return;
                // Index N means a different day next month, so the remembered tab stop
                // has to go back to the checked/first bookable day.
                setGridFocusIndex(-1);
                setViewMonth((m) => startOfMonth(addMonths(m, -1)));
              }}
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
              onClick={() => {
                if (!canGoNext) return;
                setGridFocusIndex(-1);
                setViewMonth((m) => startOfMonth(addMonths(m, 1)));
              }}
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

            {monthGrid.allDays.map((date, i) => {
              const iso = format(date, 'yyyy-MM-dd');
              const state = days[iso];
              const status: DayAvailability = state?.status ?? 'NONE';
              const disabled = !gridSelectable[i];
              const selected = selectedDate ? isSameDay(date, selectedDate) : false;
              const isToday = isSameDay(date, today);

              return (
                <button
                  key={iso}
                  ref={(node) => {
                    gridRefs.current[i] = node;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  aria-label={dayLabel(date, state, disabled, loadFailed)}
                  // One tab stop for the month, as on the strip. Up/Down walk the
                  // weekday column, which is the movement the grid's shape implies.
                  tabIndex={i === gridTabStop ? 0 : -1}
                  onFocus={() => setGridFocusIndex(i)}
                  onClick={() => pick(date, disabled)}
                  onKeyDown={(event) => dayKeyDown(event, 'grid', i, 7)}
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
