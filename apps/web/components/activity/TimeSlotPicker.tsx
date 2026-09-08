'use client';

/**
 * Time-slot picker for a chosen activity + day.
 *
 * Fetches the day's bookable slots via the shared day cache (lib/dayAvailability)
 * and renders each as a selectable chip showing the start time and remaining
 * capacity ("X spots left"). Full slots are shown disabled. Selection is
 * controlled by the parent so it can compose rate + date + time before routing
 * to checkout.
 *
 * PAST DEPARTURES ARE NOT OFFERED. For the operator's current calendar day the
 * chips are filtered to start times still ahead of the clock — a guest cannot
 * board a boat that left (same rule as the homepage departures board,
 * services/departures.ts). Days are bucketed in the OPERATOR's timezone via
 * `timeZone` (the approach commit 7ec5d9e established for the seeded strip);
 * the past/future check itself is a plain instant comparison. When a day HAS
 * slots but they are all in the past, the empty state says so and hands the
 * guest tomorrow instead of a dead "no times" shrug.
 *
 * PERFORMANCE (see docs/PERFORMANCE.md). This is the third and last round trip in
 * the booking funnel, and on Slow 4G a round trip is ~400ms before a single byte
 * of the body moves. A guest comparing Saturday against Sunday and back used to
 * pay that toll every single time, so days are held in the shared short-lived
 * cache and identical in-flight requests share one response.
 */

import { useEffect, useRef, useState } from 'react';
import { formatTime, formatISODate } from '@/lib/format';
import { loadDay, readCachedDay } from '@/lib/dayAvailability';
import { futureSlots, operatorDayISO } from '@/lib/operatorDay';
import type { AvailabilitySlot } from '@/lib/api';

interface TimeSlotPickerProps {
  activityId: string;
  /** The selected calendar day. */
  date: Date;
  selectedTimeslotId: string | null;
  onSelect: (slot: AvailabilitySlot) => void;
  /**
   * Legacy prop, retained for call-site compatibility (reschedule dialog).
   * Estate chrome no longer paints the operator/activity color; selection is
   * always the sage accent token.
   */
  accentColor?: string;
  /**
   * IANA timezone the operator's calendar days are bucketed in. Decides which
   * day counts as "today" for the past-departure filter. Falls back to the
   * browser's local day when absent (embed/reschedule callers).
   */
  timeZone?: string;
  /**
   * Renders the "See tomorrow →" action in the all-departures-ended empty
   * state. The parent selects the operator's next calendar day.
   */
  onSeeTomorrow?: () => void;
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

/**
 * Estate chip styling: surface + hairline at rest, sage border + sage-deep text
 * when chosen, quiet muted when full. Status colors live only in the small
 * capacity line (warn when filling up), never as a chip wash.
 */
function chipClasses(selected: boolean, full: boolean): string {
  const base =
    'flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-lg border-2 px-3 py-2.5 text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ink focus-visible:ring-offset-1';
  if (full) {
    return `${base} cursor-not-allowed border-hairline bg-surface text-muted opacity-60`;
  }
  if (selected) {
    return `${base} cursor-pointer border-accent bg-surface text-accent-ink`;
  }
  return `${base} cursor-pointer border-hairline bg-surface text-ink hover:border-accent`;
}

export function TimeSlotPicker({
  activityId,
  date,
  selectedTimeslotId,
  onSelect,
  timeZone,
  onSeeTomorrow,
}: TimeSlotPickerProps) {
  const iso = formatISODate(date);

  // Seed from the cache during render, not in an effect. A cached day therefore
  // paints its chips in the very first frame after the date is tapped — no skeleton
  // flash, no layout shift, and nothing for the guest to wait on.
  const cached = readCachedDay(activityId, iso);
  const [slots, setSlots] = useState<AvailabilitySlot[]>(cached ?? []);
  const [loading, setLoading] = useState(cached === null);
  const [error, setError] = useState<string | null>(null);

  const requestSeq = useRef(0);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);

  /*
   * The operator's current calendar day. For that day (or, defensively, an
   * earlier one a restored selection might carry) departures already underway
   * are dropped — the same "a departure in the past is gone" rule the homepage
   * board applies server-side. Future days pass through untouched.
   */
  const todayIso = timeZone ? operatorDayISO(timeZone) : formatISODate(new Date());
  const isToday = iso === todayIso;
  const visibleSlots = iso <= todayIso ? futureSlots(slots) : slots;
  /** The day HAD departures, but every one of them has already left. */
  const allDeparted = !loading && !error && slots.length > 0 && visibleSlots.length === 0;

  // Restore a previously chosen time (e.g. after Back from checkout). The parent
  // controls selection by id, but the CTA needs the resolved slot *object* — with
  // its live remaining capacity — before it can advance. So once the day's slots
  // load, re-emit the slot matching the controlled id, but ONLY if it is still
  // selectable: a slot that filled up (or departed) while the guest was away must
  // not silently become bookable again. Guarded to fire once per (day, id) so it
  // can never loop or override a fresh pick the guest makes after the restore.
  const restoredKey = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedTimeslotId) return;
    const key = `${iso}|${selectedTimeslotId}`;
    if (restoredKey.current === key) return;
    const match = visibleSlots.find((s) => s.timeslotId === selectedTimeslotId);
    if (!match) return;
    restoredKey.current = key;
    if (match.status === 'FULL' || match.capacityRemaining <= 0) return;
    onSelect(match);
    // onSelect is stable enough for this one-shot restore; guarding by restoredKey
    // makes re-runs no-ops regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSlots, selectedTimeslotId, iso]);

  useEffect(() => {
    const seq = ++requestSeq.current;
    let cancelled = false;

    const hit = readCachedDay(activityId, iso);
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
      allDeparted
        ? 'Today’s departures have ended.'
        : visibleSlots.length === 0
          ? 'No times are available on this day.'
          : `${visibleSlots.length} ${visibleSlots.length === 1 ? 'time' : 'times'} available.`,
    );
  }, [loading, error, visibleSlots.length, allDeparted]);

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
        {/* Shape-accurate skeleton: the height of a real chip (min-h-[52px] + border),
            so the answer arriving does not shove the guest's thumb target down. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-[52px] animate-pulse rounded-lg border border-hairline bg-surface"
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
          className="rounded-lg border border-danger bg-surface px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      </>
    );
  }

  if (allDeparted) {
    // Empty state, DESIGN.md shape: one sentence + one action. Only meaningful
    // for the operator's today; a stale past day gets the plain empty below.
    return (
      <>
        {status}
        <div className="rounded-lg border border-hairline bg-surface px-3 py-4 text-sm">
          <p className="text-ink">
            {isToday ? 'Today’s departures have ended.' : 'These departures have passed.'}
          </p>
          {onSeeTomorrow && (
            <button
              type="button"
              onClick={onSeeTomorrow}
              className="mt-1 font-semibold text-accent-ink transition-colors hover:underline"
            >
              See tomorrow →
            </button>
          )}
        </div>
      </>
    );
  }

  if (visibleSlots.length === 0) {
    return (
      <>
        {status}
        <p className="rounded-lg border border-hairline bg-surface px-3 py-3 text-sm text-muted">
          No departures this day.
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
  const selectable = visibleSlots.map(
    (slot) => !(slot.status === 'FULL' || slot.capacityRemaining <= 0),
  );
  const selectedIndex = visibleSlots.findIndex((slot) => slot.timeslotId === selectedTimeslotId);
  const tabStop = rovingIndex(selectable, selectedIndex);

  const move = (from: number, step: number) => {
    const to = nextSelectableIndex(selectable, from, step);
    const slot = to >= 0 ? visibleSlots[to] : undefined;
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
        move(visibleSlots.length, -1);
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
        {visibleSlots.map((slot, index) => {
          const full = !selectable[index];
          const selected = slot.timeslotId === selectedTimeslotId;
          const fillingUp = !full && slot.status === 'FILLING_UP';
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
              className={chipClasses(selected, full)}
            >
              <span className="tnum text-sm font-semibold">{formatTime(slot.datetime)}</span>
              <span
                className={`tnum text-[11px] font-medium ${
                  full ? 'text-muted' : fillingUp ? 'text-warn' : selected ? 'text-accent-ink' : 'text-muted'
                }`}
              >
                {spotsLabel(slot.capacityRemaining)}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

export default TimeSlotPicker;
