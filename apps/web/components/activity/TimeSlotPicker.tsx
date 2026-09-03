'use client';

/**
 * Time-slot picker for a chosen activity + day.
 *
 * Fetches the day's bookable slots via getAvailability and renders each as a
 * selectable chip showing the start time and remaining capacity ("X spots
 * left"). Full slots are shown disabled. Slot status drives the chip color so
 * it matches the month calendar's green/yellow/red language. Selection is
 * controlled by the parent so it can compose rate + date + time before routing
 * to checkout.
 *
 * PERFORMANCE (see docs/PERFORMANCE.md). This is the third and last round trip in
 * the booking funnel, and on Slow 4G a round trip is ~400ms before a single byte
 * of the body moves. A guest comparing Saturday against Sunday and back used to
 * pay that toll every single time, so days are held in a short-lived module cache
 * and identical in-flight requests share one response.
 */

import { useEffect, useRef, useState } from 'react';
import { formatTime, formatISODate } from '@/lib/format';
import {
  getAvailability,
  isApiError,
  type AvailabilitySlot,
} from '@/lib/api';

interface TimeSlotPickerProps {
  activityId: string;
  /** The selected calendar day. */
  date: Date;
  selectedTimeslotId: string | null;
  onSelect: (slot: AvailabilitySlot) => void;
  accentColor: string;
}

// ---------------------------------------------------------------------------
// Day cache
// ---------------------------------------------------------------------------

/**
 * How long a fetched day may be reused, in ms.
 *
 * Deliberately short. "Availability that never lies" (docs/LOCAL-FIRST-BUILD.md §6)
 * outranks the round trip this saves: capacity is live inventory and another guest
 * can take the last seat at any moment. Thirty seconds is long enough to make
 * flicking between two days feel instant and short enough that nothing a guest sees
 * is meaningfully older than the page they are looking at. It is not a correctness
 * boundary either way — the booking call re-checks capacity server-side and rejects
 * a slot that filled up, which is the only place that check can be trusted.
 */
const DAY_TTL_MS = 30_000;

interface CachedDay {
  slots: AvailabilitySlot[];
  fetchedAt: number;
}

const dayCache = new Map<string, CachedDay>();
/** Requests currently on the wire, so two mounts of the same day cost one. */
const inFlight = new Map<string, Promise<AvailabilitySlot[]>>();

function cacheKey(activityId: string, iso: string): string {
  return `${activityId}|${iso}`;
}

/** Cached slots for a day, or null when nothing fresh is held. */
function readCache(key: string): AvailabilitySlot[] | null {
  const hit = dayCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > DAY_TTL_MS) {
    dayCache.delete(key);
    return null;
  }
  return hit.slots;
}

/**
 * Load one day's slots, sharing an in-flight request and caching the result.
 *
 * A 404 means "this activity has no schedule that day", which is an answer rather
 * than a failure, so it caches as an empty day instead of being retried on every
 * re-render.
 */
async function loadDay(activityId: string, iso: string): Promise<AvailabilitySlot[]> {
  const key = cacheKey(activityId, iso);
  const cached = readCache(key);
  if (cached) return cached;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const pending = (async () => {
    try {
      const day = await getAvailability(activityId, iso);
      // Stable order by start time.
      const sorted = [...day.slots].sort(
        (a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime(),
      );
      dayCache.set(key, { slots: sorted, fetchedAt: Date.now() });
      return sorted;
    } catch (err) {
      if (isApiError(err) && err.status === 404) {
        dayCache.set(key, { slots: [], fetchedAt: Date.now() });
        return [];
      }
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, pending);
  return pending;
}

function spotsLabel(remaining: number): string {
  if (remaining <= 0) return 'Full';
  return `${remaining} ${remaining === 1 ? 'spot' : 'spots'} left`;
}

/**
 * The chip that owns the group's single tab stop — the checked one, or the first chip
 * a guest can actually pick. -1 when the whole day is full, which leaves the group out
 * of the tab order instead of parking focus on a sold-out chip.
 */
function rovingIndex(selectable: boolean[], selectedIndex: number): number {
  if (selectedIndex >= 0 && selectable[selectedIndex]) return selectedIndex;
  return selectable.indexOf(true);
}

/** The next pickable chip `step` away, wrapping; -1 when none is left. */
function nextSelectableIndex(selectable: boolean[], from: number, step: number): number {
  const n = selectable.length;
  if (n === 0 || step === 0) return -1;
  for (let hop = 1; hop <= n; hop++) {
    const candidate = (((from + step * hop) % n) + n) % n;
    if (selectable[candidate]) return candidate;
  }
  return -1;
}

function chipClasses(
  status: AvailabilitySlot['status'],
  selected: boolean,
  full: boolean,
): string {
  const base =
    'flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-xl border-2 px-3 py-2.5 text-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1';
  if (full) {
    return `${base} cursor-not-allowed border-rose-100 bg-rose-50 text-rose-400`;
  }
  if (selected) {
    return `${base} cursor-pointer border-slate-900 bg-slate-900 text-white shadow-sm`;
  }
  if (status === 'FILLING_UP') {
    return `${base} cursor-pointer border-amber-200 bg-amber-50 text-amber-900 hover:border-amber-400`;
  }
  return `${base} cursor-pointer border-emerald-200 bg-emerald-50 text-emerald-900 hover:border-emerald-400`;
}

export function TimeSlotPicker({
  activityId,
  date,
  selectedTimeslotId,
  onSelect,
  accentColor,
}: TimeSlotPickerProps) {
  const iso = formatISODate(date);

  // Seed from the cache during render, not in an effect. A cached day therefore
  // paints its chips in the very first frame after the date is tapped — no skeleton
  // flash, no layout shift, and nothing for the guest to wait on.
  const cached = readCache(cacheKey(activityId, iso));
  const [slots, setSlots] = useState<AvailabilitySlot[]>(cached ?? []);
  const [loading, setLoading] = useState(cached === null);
  const [error, setError] = useState<string | null>(null);

  const requestSeq = useRef(0);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Restore a previously chosen time (e.g. after Back from checkout). The parent
  // controls selection by id, but the CTA needs the resolved slot *object* — with
  // its live remaining capacity — before it can advance. So once the day's slots
  // load, re-emit the slot matching the controlled id, but ONLY if it is still
  // selectable: a slot that filled up while the guest was away must not silently
  // become bookable again. Guarded to fire once per (day, id) so it can never loop
  // or override a fresh pick the guest makes after the restore.
  const restoredKey = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedTimeslotId) return;
    const key = `${iso}|${selectedTimeslotId}`;
    if (restoredKey.current === key) return;
    const match = slots.find((s) => s.timeslotId === selectedTimeslotId);
    if (!match) return;
    restoredKey.current = key;
    if (match.status === 'FULL' || match.capacityRemaining <= 0) return;
    onSelect(match);
    // onSelect is stable enough for this one-shot restore; guarding by restoredKey
    // makes re-runs no-ops regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, selectedTimeslotId, iso]);

  useEffect(() => {
    const seq = ++requestSeq.current;
    let cancelled = false;

    const hit = readCache(cacheKey(activityId, iso));
    if (hit) {
      setSlots(hit);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    (async () => {
      try {
        const day = await loadDay(activityId, iso);
        if (cancelled || seq !== requestSeq.current) return;
        setSlots(day);
      } catch {
        if (cancelled || seq !== requestSeq.current) return;
        setError('Could not load times for this day. Please try again.');
      } finally {
        if (!cancelled && seq === requestSeq.current) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activityId, iso]);

  /*
   * 4.1.3 Status Messages. This picker mounts the moment a date is tapped, so a live
   * region rendered with its message already inside it would be an INSERTION, which
   * assistive tech does not reliably announce. Holding the text back by one commit
   * turns it into the update it has to be for the guest to hear anything.
   *
   * The region itself is rendered in every state below, at the same position, so it
   * survives loading → loaded and reports the end of the wait as well as the start.
   */
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (loading) {
      setAnnouncement('Loading available times…');
      return;
    }
    // The failure has its own alert; repeating it here would say it twice.
    if (error) {
      setAnnouncement('');
      return;
    }
    setAnnouncement(
      slots.length === 0
        ? 'No times are available on this day.'
        : `${slots.length} ${slots.length === 1 ? 'time' : 'times'} available.`,
    );
  }, [loading, error, slots.length]);

  /**
   * The live region, always the FIRST child of the returned fragment.
   *
   * Same type, same position in every branch, so React keeps the one element across
   * loading → loaded instead of remounting it and losing the announcement. It stays
   * outside the radiogroup on purpose: a `status` is not an allowed child of a
   * `radiogroup`, and putting it there would trade one finding for another.
   */
  const status = (
    <span role="status" className="sr-only">
      {announcement}
    </span>
  );

  if (loading) {
    return (
      <>
        {status}
        {/* The placeholders are the height of a real chip (min-h-[52px] + border), so
            the answer arriving does not shove the guest's thumb target down the page. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-[52px] animate-pulse rounded-xl border-2 border-slate-100 bg-slate-100"
              aria-hidden
            />
          ))}
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        {status}
        {/* Inserted with no focus move, so it has to announce itself. */}
        <p
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
        >
          {error}
        </p>
      </>
    );
  }

  if (slots.length === 0) {
    return (
      <>
        {status}
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
          No times are available on this day. Try another date.
        </p>
      </>
    );
  }

  /*
   * Keyboard semantics for the radiogroup: one tab stop for the whole group (the
   * chosen chip, or the first pickable one), and arrows to move inside it. Twelve
   * timeslots used to be twelve tab stops between the date and the CTA.
   *
   * Selection follows focus here, unlike the date strip. Choosing a time is pure local
   * state — no request, nothing discarded — so the native radio behaviour is free, and
   * it keeps what the screen reader announces and what the booking will use identical.
   *
   * Left/Up and Right/Down all step by one rather than by a row: the grid is two
   * columns on a phone and three from `sm` up, so any fixed row step would be a lie on
   * one of them.
   */
  const selectable = slots.map((slot) => !(slot.status === 'FULL' || slot.capacityRemaining <= 0));
  const selectedIndex = slots.findIndex((slot) => slot.timeslotId === selectedTimeslotId);
  const tabStop = rovingIndex(selectable, selectedIndex);

  const move = (from: number, step: number) => {
    const to = nextSelectableIndex(selectable, from, step);
    const slot = to >= 0 ? slots[to] : undefined;
    if (!slot) return;
    chipRefs.current[to]?.focus();
    onSelect(slot);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        move(index, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        move(index, -1);
        break;
      case 'Home':
        event.preventDefault();
        move(-1, 1);
        break;
      case 'End':
        event.preventDefault();
        move(slots.length, -1);
        break;
      default:
        break;
    }
  };

  return (
    <>
      {status}
      <div
        className="grid grid-cols-2 gap-2 sm:grid-cols-3"
        role="radiogroup"
        aria-label="Choose a time"
      >
        {slots.map((slot, index) => {
          const full = !selectable[index];
          const selected = slot.timeslotId === selectedTimeslotId;
          return (
            <button
              key={slot.timeslotId}
              ref={(node) => {
                chipRefs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={full}
              tabIndex={index === tabStop ? 0 : -1}
              onClick={() => onSelect(slot)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={chipClasses(slot.status, selected, full)}
            >
              <span className="text-sm font-semibold">{formatTime(slot.datetime)}</span>
              <span
                className={`text-[11px] font-medium ${
                  selected ? 'text-white/80' : full ? 'text-rose-400' : 'opacity-80'
                }`}
              >
                {spotsLabel(slot.capacityRemaining)}
              </span>
              {selected && (
                <span
                  aria-hidden
                  className="mt-0.5 h-1 w-6 rounded-full"
                  style={{ backgroundColor: accentColor }}
                />
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

export default TimeSlotPicker;
