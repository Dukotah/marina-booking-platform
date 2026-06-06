'use client';

/**
 * Customer self-service reschedule picker for a single booked item.
 *
 * Flow:
 *   1. Shows the booking's activity + the slot it's currently booked for.
 *   2. Customer picks a new date (reusing the same color-coded month calendar as
 *      checkout) → the day's bookable slots load as selectable "X spots left"
 *      cards (reusing the checkout TimeSlotPicker visual language).
 *   3. Confirm calls the `rescheduleBooking` server action, which hits the API's
 *      self-reschedule endpoint (identity = httpOnly session cookie, not a URL
 *      param). Success shows the moved slot + refreshes the booking view; the
 *      API's friendly window/capacity error is surfaced verbatim on rejection.
 *
 * The activity's `self_reschedule_hours` window is fetched client-side via
 * getActivity (the flat order line item doesn't carry it). We render a clear note
 * about the window and soft-block confirming once the current slot is inside it —
 * the server is still the authority and re-checks.
 *
 * White-label: copy uses the operator brand only; accents follow --brand-color.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, cn } from '@marina/ui';
import { formatLongDate, formatTime, formatISODate } from '@/lib/format';
import {
  getActivity,
  getAvailability,
  isApiError,
  type AvailabilitySlot,
} from '@/lib/api';
import { rescheduleBooking } from '@/app/account/actions';

export interface RescheduleSlotPickerProps {
  /** The item being moved (used to disambiguate multi-item orders). */
  orderItemId: string;
  activityId: string;
  activityName: string;
  rateName: string;
  /** ISO datetime the item is currently booked for. */
  currentDatetime: string;
  /** Brand accent for selected affordances. */
  accentColor: string;
  /** Called after a successful reschedule (e.g. to close the modal). */
  onDone?: () => void;
}

function spotsLabel(remaining: number): string {
  if (remaining <= 0) return 'Full';
  return `${remaining} ${remaining === 1 ? 'spot' : 'spots'} left`;
}

function slotCardClasses(
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

export function RescheduleSlotPicker({
  orderItemId,
  activityId,
  activityName,
  rateName,
  currentDatetime,
  accentColor,
  onDone,
}: RescheduleSlotPickerProps) {
  const router = useRouter();

  // self_reschedule_hours — fetched from the activity detail (the order line item
  // doesn't carry it). null while loading / on failure (treated as "no window").
  const [windowHours, setWindowHours] = useState<number | null>(null);

  // Date is a YYYY-MM-DD string in the operator calendar (matches availability).
  const [date, setDate] = useState<string>('');
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AvailabilitySlot | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successDatetime, setSuccessDatetime] = useState<string | null>(null);

  const slotSeq = useRef(0);

  // The earliest date the customer may pick (today, YYYY-MM-DD local).
  const todayIso = formatISODate(new Date());

  // Whether the current slot is already inside the no-reschedule window. The
  // server is authoritative; this only drives a friendly soft-block + note.
  const windowClosed =
    windowHours !== null &&
    Date.now() > new Date(currentDatetime).getTime() - windowHours * 3_600_000;

  // Load the activity's reschedule window once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const detail = await getActivity(activityId);
        if (!cancelled) setWindowHours(detail.selfRescheduleHours ?? 0);
      } catch {
        // Non-fatal: leave the window unknown; the server still enforces it.
        if (!cancelled) setWindowHours(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activityId]);

  // Load slots whenever the chosen date changes.
  useEffect(() => {
    if (!date) {
      setSlots([]);
      return;
    }
    const seq = ++slotSeq.current;
    let cancelled = false;
    setSlotsLoading(true);
    setSlotsError(null);
    setSelected(null);
    (async () => {
      try {
        const day = await getAvailability(activityId, date);
        if (cancelled || seq !== slotSeq.current) return;
        const sorted = [...day.slots].sort(
          (a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime(),
        );
        setSlots(sorted);
      } catch (err) {
        if (cancelled || seq !== slotSeq.current) return;
        if (isApiError(err) && err.status === 404) {
          setSlots([]);
        } else {
          setSlotsError('Could not load times for this day. Please try again.');
        }
      } finally {
        if (!cancelled && seq === slotSeq.current) setSlotsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activityId, date]);

  const handleConfirm = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    const res = await rescheduleBooking({
      timeslotId: selected.timeslotId,
      orderItemId,
    });
    setSubmitting(false);
    if (res.ok) {
      setSuccessDatetime(selected.datetime);
      // Refresh the server-rendered booking view so totals/slots reflect the move.
      router.refresh();
    } else {
      setError(res.error);
    }
  };

  // --- Success state --------------------------------------------------------
  if (successDatetime) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#047857" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <p className="text-sm font-semibold text-emerald-900">Your booking has been moved</p>
        <p className="mt-1 text-sm text-emerald-800">
          {activityName} is now booked for{' '}
          <span className="font-medium">{formatLongDate(successDatetime)}</span> at{' '}
          <span className="font-medium">{formatTime(successDatetime)}</span>.
        </p>
        <Button
          variant="brand"
          size="sm"
          className="mt-4"
          onClick={() => onDone?.()}
        >
          Done
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Current booking */}
      <div className="rounded-xl bg-slate-50 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Currently booked for
        </p>
        <p className="mt-1 font-semibold text-slate-900">{activityName}</p>
        <p className="text-sm text-slate-600">{rateName}</p>
        <p className="mt-1 text-sm font-medium text-slate-900">
          {formatLongDate(currentDatetime)} · {formatTime(currentDatetime)}
        </p>
      </div>

      {/* Window note */}
      {windowHours !== null && windowHours > 0 && (
        <p
          className={cn(
            'rounded-lg border px-3 py-2 text-sm',
            windowClosed
              ? 'border-amber-200 bg-amber-50 text-amber-900'
              : 'border-slate-200 bg-white text-slate-600',
          )}
        >
          {windowClosed
            ? `Online reschedules close ${windowHours} hour${windowHours === 1 ? '' : 's'} before your slot, so this booking can no longer be moved online. Please contact us for help.`
            : `Reschedules must be made at least ${windowHours} hour${windowHours === 1 ? '' : 's'} before your slot.`}
        </p>
      )}

      {!windowClosed && (
        <>
          {/* Date picker */}
          <div>
            <label
              htmlFor="reschedule-date"
              className="mb-1.5 block text-sm font-semibold text-slate-700"
            >
              Pick a new date
            </label>
            <input
              id="reschedule-date"
              type="date"
              min={todayIso}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm transition focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-[var(--brand-color,#0f766e)] focus:ring-offset-1"
            />
          </div>

          {/* Slots for the chosen date */}
          {date && (
            <div>
              <p className="mb-2 text-sm font-semibold text-slate-700">Choose a time</p>
              {slotsLoading ? (
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
              ) : slotsError ? (
                <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {slotsError}
                </p>
              ) : slots.length === 0 ? (
                <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
                  No times are available on this day. Try another date.
                </p>
              ) : (
                <div
                  className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                  role="radiogroup"
                  aria-label="Choose a new time"
                >
                  {slots.map((slot) => {
                    const full = slot.status === 'FULL' || slot.capacityRemaining <= 0;
                    const isSel = slot.timeslotId === selected?.timeslotId;
                    const isCurrent =
                      new Date(slot.datetime).getTime() ===
                      new Date(currentDatetime).getTime();
                    return (
                      <button
                        key={slot.timeslotId}
                        type="button"
                        role="radio"
                        aria-checked={isSel}
                        disabled={full || isCurrent}
                        onClick={() => setSelected(slot)}
                        className={cn(
                          slotCardClasses(slot.status, isSel, full),
                          isCurrent && 'cursor-not-allowed opacity-50',
                        )}
                      >
                        <span className="text-sm font-semibold">
                          {formatTime(slot.datetime)}
                        </span>
                        <span
                          className={cn(
                            'text-[11px] font-medium',
                            isSel ? 'text-white/80' : full ? 'text-rose-400' : 'opacity-80',
                          )}
                        >
                          {isCurrent ? 'Current slot' : spotsLabel(slot.capacityRemaining)}
                        </span>
                        {isSel && (
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
              )}
            </div>
          )}

          {/* Error + confirm */}
          {error && (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            {onDone && (
              <Button variant="outline" onClick={() => onDone()} disabled={submitting}>
                Cancel
              </Button>
            )}
            <Button
              variant="brand"
              loading={submitting}
              disabled={!selected || submitting}
              onClick={handleConfirm}
            >
              {selected
                ? `Move to ${formatTime(selected.datetime)}`
                : 'Confirm new time'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export default RescheduleSlotPicker;
