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
 * query params so the checkout slice can hydrate the cart. The selection is also
 * mirrored to sessionStorage (keyed by activity) so that pressing Back from
 * checkout restores the chosen rate, date, time, and party size instead of
 * dumping the guest back onto an empty form. See `restoreSelection` below.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { parseISO, startOfDay } from 'date-fns';
import { formatUSD, formatISODate, formatLongDate, formatTime } from '@/lib/format';
import type {
  ActivityDetail,
  AvailabilitySlot,
  CatalogRate,
} from '@/lib/api';
import { onBrandForeground } from '@/lib/brand';
import { RateCards } from './RateCards';
import type { RangeDay } from '../booking/AvailabilityCalendar';

/**
 * A guest's in-progress selection, persisted so Back from checkout restores it.
 *
 * Only primitives are stored — the ids the guest chose plus the party size — never
 * the resolved slot object, which is live inventory that must be re-fetched (its
 * remaining capacity can change while the guest is away). The timeslot is restored
 * by handing its id to TimeSlotPicker, which re-selects the matching slot from the
 * freshly loaded day so we never advance to checkout on stale capacity.
 */
interface PersistedSelection {
  rateId: string | null;
  dateISO: string | null;
  timeslotId: string | null;
  quantity: number;
}

/** sessionStorage key for one activity's in-progress selection. */
function selectionKey(activityId: string): string {
  return `booking:selection:${activityId}`;
}

/** Read a persisted selection for this activity, or null when none/invalid. */
function restoreSelection(activityId: string): PersistedSelection | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(selectionKey(activityId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedSelection>;
    return {
      rateId: typeof parsed.rateId === 'string' ? parsed.rateId : null,
      dateISO: typeof parsed.dateISO === 'string' ? parsed.dateISO : null,
      timeslotId: typeof parsed.timeslotId === 'string' ? parsed.timeslotId : null,
      quantity:
        typeof parsed.quantity === 'number' && Number.isFinite(parsed.quantity)
          ? parsed.quantity
          : 1,
    };
  } catch {
    return null;
  }
}

/** Persist (or clear) this activity's in-progress selection. */
function persistSelection(activityId: string, value: PersistedSelection | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) {
      window.sessionStorage.removeItem(selectionKey(activityId));
    } else {
      window.sessionStorage.setItem(selectionKey(activityId), JSON.stringify(value));
    }
  } catch {
    // Private-mode / quota failures are non-fatal: the funnel works without the
    // restore, exactly as it did before this was added.
  }
}

/*
 * The calendar and the time picker load as separate chunks.
 *
 * This whole widget is one client boundary, so React hydrates all of it before ANY
 * of it responds — and the calendar is by far the heaviest part of it. On Slow 4G
 * with a slow phone CPU that meant the very first control, the rate picker, sat
 * rendered but inert for seconds: a guest could see it, tap it, and nothing
 * happened. Splitting the two steps the guest has not reached yet out of the
 * initial chunk lets step 1 become interactive first, which is the whole point of
 * the sub-30s mobile target in docs/LOCAL-FIRST-BUILD.md section 6.
 *
 * ssr stays ON: the markup must still be in the server response for a guest who is
 * further down the page, and for anyone without JavaScript.
 */
const AvailabilityCalendar = dynamic(
  () => import('../booking/AvailabilityCalendar').then((m) => m.AvailabilityCalendar),
  { ssr: true },
);
const TimeSlotPicker = dynamic(
  () => import('./TimeSlotPicker').then((m) => m.TimeSlotPicker),
  { ssr: true },
);

interface BookingWidgetProps {
  activity: ActivityDetail;
  /** Strip-window availability rendered on the server; see AvailabilityCalendar. */
  initialRange?: RangeDay[];
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
          className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold"
          style={{
            backgroundColor: done ? accentColor : '#94a3b8',
            color: onBrandForeground(done ? accentColor : '#94a3b8'),
          }}
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

/**
 * Hand a radiogroup to the pre-hydration driver, then take it back.
 *
 * The activity page ships a tiny inline script that drives any group marked with
 * `data-prehydration-radiogroup` before the route's JavaScript exists, so a rate tap on
 * a throttled phone lands in the same frame instead of being thrown away (see
 * `PRE_HYDRATION_RADIOS` in `app/activities/[id]/page.tsx`, and docs/PERFORMANCE.md
 * §2.3). This is the other half of that handshake:
 *
 *   1. it opts the group in, and carries the brand accent the pre-hydration stylesheet
 *      paints the selection with;
 *   2. on mount it reads back whatever the guest already chose and adopts it into React
 *      state, so the tap survives hydration rather than being reset to nothing;
 *   3. only then does it flip `data-hydrated`, which silences the script. Adopting
 *      first matters: flipping the flag before reading would drop a tap that landed
 *      between the two.
 *
 * The choice comes back as a position in the group rather than an id, because the
 * markup inside belongs to `RateCards` and carries no identifier the script could read.
 * `RateCards` maps `rates` straight through, so index N is `rates[N]`.
 */
function PreHydrationRadioGroup({
  accentColor,
  onAdopt,
  children,
}: {
  accentColor: string;
  /** Called once, with the index of a radio the guest tapped before hydration. */
  onAdopt: (index: number) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hydrated, setHydrated] = useState(false);

  // Read through a ref so a new callback identity on a re-render cannot re-run the
  // adoption and overwrite a choice the guest has since changed.
  const adopt = useRef(onAdopt);
  adopt.current = onAdopt;

  useEffect(() => {
    const chosen = ref.current?.getAttribute('data-preselected');
    const index = chosen === null || chosen === undefined ? -1 : Number(chosen);
    if (Number.isInteger(index) && index >= 0) adopt.current(index);
    setHydrated(true);
  }, []);

  return (
    <div
      ref={ref}
      data-prehydration-radiogroup="rate"
      // Server and first client render agree on 'false'; the effect above is what
      // changes it, after React is genuinely listening.
      data-hydrated={hydrated ? 'true' : 'false'}
      style={{ '--prehydration-accent': accentColor } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

export function BookingWidget({ activity, initialRange }: BookingWidgetProps) {
  const router = useRouter();
  const accent = activity.color;

  // Restore any in-progress selection saved before the guest left for checkout,
  // so Back does not wipe their choices. Read once, lazily, during the initial
  // render (same value on server and first client render is not a concern — this
  // is a client component with no SSR of the restored value). `restored` is null
  // on a fresh visit, which leaves every default exactly as it was.
  const restoredRef = useRef<PersistedSelection | null>(null);
  if (restoredRef.current === null) {
    restoredRef.current = restoreSelection(activity.id) ?? {
      rateId: null,
      dateISO: null,
      timeslotId: null,
      quantity: Math.max(1, activity.minParticipants),
    };
  }
  const restored = restoredRef.current;

  const [rate, setRate] = useState<CatalogRate | null>(() => {
    const fromStore = restored.rateId
      ? (activity.rates.find((r) => r.id === restored.rateId) ?? null)
      : null;
    if (fromStore) return fromStore;
    return activity.rates.length === 1 ? (activity.rates[0] ?? null) : null;
  });
  const [date, setDate] = useState<Date | null>(() =>
    restored.dateISO ? startOfDay(parseISO(restored.dateISO)) : null,
  );
  const [slot, setSlot] = useState<AvailabilitySlot | null>(null);
  const [quantity, setQuantity] = useState<number>(() =>
    Math.max(Math.max(1, activity.minParticipants), restored.quantity || 1),
  );

  // The timeslot the guest had chosen, if any. Held until TimeSlotPicker loads
  // the day and re-selects the matching slot (which sets the real `slot` object
  // above and clears this). Only used to drive the picker's controlled selection.
  const [pendingTimeslotId, setPendingTimeslotId] = useState<string | null>(
    restored.timeslotId,
  );

  // Capacity ceiling: never exceed the slot's TRUE remaining spots or the activity
  // max. An unset (0) activity max falls back to the slot's remaining capacity so
  // it never collapses the ceiling to zero. Mirrors the checkout page clamp.
  const maxQty = useMemo(() => {
    const slotCap = slot ? Math.max(0, slot.capacityRemaining) : Infinity;
    const activityCap = activity.maxParticipants || slotCap;
    return Math.max(1, Math.min(activityCap, slotCap));
  }, [slot, activity.maxParticipants]);

  const minQty = Math.max(1, activity.minParticipants);
  const clampedQty = Math.min(Math.max(quantity, minQty), Math.max(minQty, maxQty));

  // Ready only when a rate, date, and a slot that TRULY still has room are chosen.
  // Guards against advancing to checkout on a slot that sold out after selection.
  const ready =
    rate !== null && date !== null && slot !== null && slot.capacityRemaining > 0;
  const lineTotalCents = rate ? rate.priceCents * clampedQty : 0;

  /**
   * Take over a rate the guest chose before this component existed.
   *
   * Only ever runs when nothing is selected yet: the single-rate default below already
   * agrees with whatever was tapped, and a guest cannot have interacted with React
   * before its mount effect, so there is no live choice this could overwrite.
   */
  const adoptPreHydrationRate = (index: number) => {
    const chosen = activity.rates[index];
    if (chosen) setRate((current) => current ?? chosen);
  };

  // Choosing a new date invalidates the previously chosen time slot — including a
  // restored one, so a guest who changes the date does not carry a stale timeslot.
  const handleSelectDate = (d: Date) => {
    setDate(d);
    setSlot(null);
    setPendingTimeslotId(null);
  };

  const handleSelectSlot = (s: AvailabilitySlot) => {
    setSlot(s);
    // A real slot object now backs the selection, so the restore placeholder is done.
    setPendingTimeslotId(null);
    // Re-clamp quantity down if the newly chosen slot has fewer spots.
    setQuantity((q) => Math.min(Math.max(q, minQty), Math.max(minQty, s.capacityRemaining)));
  };

  // The timeslot id the picker should show as chosen: the live slot's id once one
  // is resolved, otherwise the id awaiting restore from the loaded day.
  const effectiveTimeslotId = slot?.timeslotId ?? pendingTimeslotId;

  // Mirror the in-progress selection to sessionStorage on every change, so Back
  // from checkout restores it. Keyed by activity, primitives only (see
  // PersistedSelection). Nothing here is fatal if storage is unavailable.
  useEffect(() => {
    persistSelection(activity.id, {
      rateId: rate?.id ?? null,
      dateISO: date ? formatISODate(date) : null,
      timeslotId: effectiveTimeslotId,
      quantity: clampedQty,
    });
  }, [activity.id, rate?.id, date, effectiveTimeslotId, clampedQty]);

  const proceedToCheckout = () => {
    if (!ready || !rate || !date || !slot) return;
    // Save the exact selection first, so pressing Back from checkout restores it.
    persistSelection(activity.id, {
      rateId: rate.id,
      dateISO: formatISODate(date),
      timeslotId: slot.timeslotId,
      quantity: clampedQty,
    });
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
          <PreHydrationRadioGroup accentColor={accent} onAdopt={adoptPreHydrationRate}>
            <RateCards
              rates={activity.rates}
              selectedRateId={rate?.id ?? null}
              onSelect={setRate}
              accentColor={accent}
            />
          </PreHydrationRadioGroup>
        </Step>

        <Step index={2} title="Pick a date" done={date !== null} accentColor={accent}>
          <AvailabilityCalendar
            activityId={activity.id}
            selectedDate={date}
            onSelectDate={handleSelectDate}
            initialRange={initialRange}
          />
        </Step>

        <Step index={3} title="Select a time" done={slot !== null} accentColor={accent}>
          {date ? (
            <TimeSlotPicker
              activityId={activity.id}
              date={date}
              selectedTimeslotId={effectiveTimeslotId}
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
                className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 text-lg font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30"
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
                className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 text-lg font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30"
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
            className="flex min-h-[52px] w-full items-center justify-center rounded-xl px-4 py-3 text-center text-base font-semibold shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            // The accent is the activity's own colour, so a hardcoded white label is a
            // coin flip: on the seeded sky blue it measured 2.71:1. Derive a foreground
            // that holds for whatever colour the operator picked.
            style={{ backgroundColor: accent, color: onBrandForeground(accent) }}
          >
            {ready ? `Continue to checkout · ${formatUSD(lineTotalCents)}` : 'Continue to checkout'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default BookingWidget;
