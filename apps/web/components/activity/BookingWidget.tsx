'use client';

/**
 * Booking widget — the interactive heart of the activity detail page.
 *
 * Composes the three selections a customer must make before checkout:
 *   1. a rate (duration + price)         — RateCards
 *   2. a date (color-coded month grid)   — AvailabilityCalendar
 *   3. a time slot ("X spots left")      — TimeSlotPicker
 *   ...plus a participant quantity, clamped to the activity's min/max and the
 *      chosen slot's remaining capacity.
 *
 * When all three are chosen it routes to /checkout, passing the selection as
 * query params so the checkout slice can hydrate the cart. State (not just the
 * id) is also pushed via the router so a soft navigation preserves it without a
 * refetch where possible.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatUSD, formatISODate, formatLongDate, formatTime } from '@/lib/format';
import type {
  ActivityDetail,
  AvailabilitySlot,
  CatalogRate,
} from '@/lib/api';
import { RateCards } from './RateCards';
import { TimeSlotPicker } from './TimeSlotPicker';
import { AvailabilityCalendar } from '../booking/AvailabilityCalendar';

interface BookingWidgetProps {
  activity: ActivityDetail;
}

/** A labeled step wrapper with a numbered badge. */
function Step({
  index,
  title,
  done,
  accentColor,
  children,
}: {
  index: number;
  title: string;
  done: boolean;
  accentColor: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-slate-100 pt-5 first:border-t-0 first:pt-0">
      <div className="mb-3 flex items-center gap-2.5">
        <span
          aria-hidden
          className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white"
          style={{ backgroundColor: done ? accentColor : '#94a3b8' }}
        >
          {done ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            index
          )}
        </span>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

export function BookingWidget({ activity }: BookingWidgetProps) {
  const router = useRouter();
  const accent = activity.color;

  const [rate, setRate] = useState<CatalogRate | null>(
    activity.rates.length === 1 ? (activity.rates[0] ?? null) : null,
  );
  const [date, setDate] = useState<Date | null>(null);
  const [slot, setSlot] = useState<AvailabilitySlot | null>(null);
  const [quantity, setQuantity] = useState<number>(Math.max(1, activity.minParticipants));

  // Capacity ceiling: never exceed the slot's remaining spots or the activity max.
  const maxQty = useMemo(() => {
    const cap = slot ? Math.max(1, slot.capacityRemaining) : activity.maxParticipants;
    return Math.min(activity.maxParticipants, cap);
  }, [slot, activity.maxParticipants]);

  const minQty = Math.max(1, activity.minParticipants);
  const clampedQty = Math.min(Math.max(quantity, minQty), Math.max(minQty, maxQty));

  const ready = rate !== null && date !== null && slot !== null;
  const lineTotalCents = rate ? rate.priceCents * clampedQty : 0;

  // Choosing a new date invalidates the previously chosen time slot.
  const handleSelectDate = (d: Date) => {
    setDate(d);
    setSlot(null);
  };

  const handleSelectSlot = (s: AvailabilitySlot) => {
    setSlot(s);
    // Re-clamp quantity down if the newly chosen slot has fewer spots.
    setQuantity((q) => Math.min(Math.max(q, minQty), Math.max(minQty, s.capacityRemaining)));
  };

  const proceedToCheckout = () => {
    if (!ready || !rate || !date || !slot) return;
    const params = new URLSearchParams({
      activityId: activity.id,
      rateId: rate.id,
      timeslotId: slot.timeslotId,
      date: formatISODate(date),
      datetime: slot.datetime,
      quantity: String(clampedQty),
    });
    router.push(`/checkout?${params.toString()}`);
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-6">
        <Step index={1} title="Choose a rate" done={rate !== null} accentColor={accent}>
          <RateCards
            rates={activity.rates}
            selectedRateId={rate?.id ?? null}
            onSelect={setRate}
            accentColor={accent}
          />
        </Step>

        <Step index={2} title="Pick a date" done={date !== null} accentColor={accent}>
          <AvailabilityCalendar
            activityId={activity.id}
            selectedDate={date}
            onSelectDate={handleSelectDate}
          />
        </Step>

        <Step index={3} title="Select a time" done={slot !== null} accentColor={accent}>
          {date ? (
            <TimeSlotPicker
              activityId={activity.id}
              date={date}
              selectedTimeslotId={slot?.timeslotId ?? null}
              onSelect={handleSelectSlot}
              accentColor={accent}
            />
          ) : (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
              Pick a date above to see available times.
            </p>
          )}
        </Step>

        {/* Quantity */}
        <section className="border-t border-slate-100 pt-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">
                Guests
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {minQty === maxQty
                  ? `${minQty} per booking`
                  : `${minQty}–${maxQty} per booking`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Decrease guests"
                disabled={clampedQty <= minQty}
                onClick={() => setQuantity((q) => Math.max(minQty, q - 1))}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 text-lg font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30"
              >
                −
              </button>
              <span
                className="min-w-[2ch] text-center text-lg font-semibold tabular-nums text-slate-900"
                aria-live="polite"
              >
                {clampedQty}
              </span>
              <button
                type="button"
                aria-label="Increase guests"
                disabled={clampedQty >= maxQty}
                onClick={() => setQuantity((q) => Math.min(maxQty, q + 1))}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 text-lg font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30"
              >
                +
              </button>
            </div>
          </div>
        </section>

        {/* Summary + CTA */}
        <div className="border-t border-slate-100 pt-5">
          {ready && rate && date && slot ? (
            <div className="mb-4 space-y-1.5 rounded-xl bg-slate-50 p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Rate</span>
                <span className="font-medium text-slate-900">{rate.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">When</span>
                <span className="text-right font-medium text-slate-900">
                  {formatLongDate(date)}
                  <br />
                  <span className="text-slate-600">{formatTime(slot.datetime)}</span>
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Guests</span>
                <span className="font-medium text-slate-900">{clampedQty}</span>
              </div>
              <div className="mt-1 flex justify-between border-t border-slate-200 pt-2">
                <span className="font-semibold text-slate-700">Subtotal</span>
                <span className="font-bold text-slate-900">{formatUSD(lineTotalCents)}</span>
              </div>
            </div>
          ) : (
            <p className="mb-4 text-sm text-slate-500">
              Select a rate, date, and time to continue.
            </p>
          )}

          <button
            type="button"
            disabled={!ready}
            onClick={proceedToCheckout}
            className="w-full rounded-xl px-4 py-3 text-center text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ backgroundColor: accent }}
          >
            {ready ? `Continue to checkout · ${formatUSD(lineTotalCents)}` : 'Continue to checkout'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default BookingWidget;
