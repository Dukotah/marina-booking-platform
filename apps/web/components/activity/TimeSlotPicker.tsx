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

function spotsLabel(remaining: number): string {
  if (remaining <= 0) return 'Full';
  return `${remaining} ${remaining === 1 ? 'spot' : 'spots'} left`;
}

function chipClasses(
  status: AvailabilitySlot['status'],
  selected: boolean,
  full: boolean,
): string {
  const base =
    'flex flex-col items-center gap-0.5 rounded-xl border-2 px-3 py-2.5 text-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1';
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
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const requestSeq = useRef(0);
  const iso = formatISODate(date);

  useEffect(() => {
    const seq = ++requestSeq.current;
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const day = await getAvailability(activityId, iso);
        if (cancelled || seq !== requestSeq.current) return;
        // Stable order by start time.
        const sorted = [...day.slots].sort(
          (a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime(),
        );
        setSlots(sorted);
      } catch (err) {
        if (cancelled || seq !== requestSeq.current) return;
        if (isApiError(err) && err.status === 404) {
          setSlots([]);
        } else {
          setError('Could not load times for this day. Please try again.');
        }
      } finally {
        if (!cancelled && seq === requestSeq.current) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activityId, iso]);

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-xl border-2 border-slate-100 bg-slate-100"
            aria-hidden
          />
        ))}
        <span className="sr-only">Loading available times…</span>
      </div>
    );
  }

  if (error) {
    return (
      <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
        {error}
      </p>
    );
  }

  if (slots.length === 0) {
    return (
      <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
        No times are available on this day. Try another date.
      </p>
    );
  }

  return (
    <div
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      role="radiogroup"
      aria-label="Choose a time"
    >
      {slots.map((slot) => {
        const full = slot.status === 'FULL' || slot.capacityRemaining <= 0;
        const selected = slot.timeslotId === selectedTimeslotId;
        return (
          <button
            key={slot.timeslotId}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={full}
            onClick={() => onSelect(slot)}
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
  );
}

export default TimeSlotPicker;
