'use client';

/**
 * Booking widget — the interactive heart of the activity detail page.
 *
 * Estate anatomy (DESIGN.md, Airbnb reference): this IS the sticky booking card
 * on desktop — rate → date → time → guests → itemized all-in total → the one
 * sage CTA. On a phone it stays in flow (the selections need the room) and a
 * fixed bottom bar carries the price + CTA, exactly as the checkout does.
 *
 * Composes the three selections a customer must make before checkout:
 *   1. a rate (duration + price)         — RateCards
 *   2. a date (strip + month grid)       — AvailabilityCalendar
 *   3. a time slot ("X spots left")      — TimeSlotPicker
 *   ...plus a participant quantity, clamped to the activity's min/max and the
 *      chosen slot's remaining capacity.
 *
 * When all three are chosen it routes to /checkout, passing the selection as
 * query params so the checkout slice can hydrate the cart. The selection is also
 * mirrored to sessionStorage (keyed by activity) so that pressing Back from
 * checkout restores the chosen rate, date, time, and party size instead of
 * dumping the guest back onto an empty form. See `restoreSelection` below.
 *
 * DEEP LINKS. The homepage departures board links straight at a departure
 * (`?date=YYYY-MM-DD&slot=<timeslotId>&rate=<rateId>`), and this widget adopts
 * those as its initial selection so board tap → checkout is two taps. Stale or
 * sold-out params degrade silently: the timeslot is validated against the
 * freshly loaded day (the same guard the Back-restore uses), a past date is
 * ignored, an unknown rate falls back to the normal default.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { parseISO, startOfDay } from 'date-fns';
import { calculatePricing } from '@marina/core';
import { formatUSD, formatISODate, formatLongDate, formatTime } from '@/lib/format';
import { operatorDayISO } from '@/lib/operatorDay';
import type {
  ActivityDetail,
  AvailabilitySlot,
  CatalogRate,
} from '@/lib/api';
import { RateCards } from './RateCards';
import type { RangeDay } from '../booking/AvailabilityCalendar';

/** The `?date=&slot=&rate=` selection a departures-board link carries. */
export interface DeepLinkSelection {
  date?: string;
  slot?: string;
  rate?: string;
}

/**
 * A guest's in-progress selection, persisted so Back from checkout restores it.
 *
 * Only primitives are stored — the ids the guest chose plus the party size — never
 * the resolved slot object, which is live inventory that must be re-fetched (its
 * remaining capacity can change while the guest is away). The timeslot is restored
 * by handing its id to TimeSlotPicker, which re-selects the matching slot from the
 * freshly loaded day so we never advance to checkout on stale capacity.
 *
 * `appliedDeepLink` records the last board deep-link this widget adopted, which is
 * how a NEW board tap (different or first-seen params) is told apart from Back
 * from checkout on a deep-linked URL: the former applies the link, the latter
 * restores the guest's own later edits.
 */
interface PersistedSelection {
  rateId: string | null;
  dateISO: string | null;
  timeslotId: string | null;
  quantity: number;
  appliedDeepLink?: string | null;
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
      appliedDeepLink:
        typeof parsed.appliedDeepLink === 'string' ? parsed.appliedDeepLink : null,
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
  /**
   * IANA timezone the operator's calendar days are bucketed in. Keeps the date
   * strip, the past-departure filter, and the server-seeded range on the same
   * calendar (commit 7ec5d9e). Optional for embed callers, which fall back to
   * the browser-local day.
   */
  timeZone?: string;
  /** Board deep-link params to adopt as the initial selection. */
  preselect?: DeepLinkSelection;
  /**
   * Render the fixed mobile price+CTA bar. The activity page turns this on; the
   * embed leaves it off — a viewport-fixed bar inside a host page's iframe would
   * pin itself to the iframe, not the phone.
   */
  stickyMobileCta?: boolean;
}

/**
 * A labeled selection group. Estate keeps these quiet: a 13px uppercase muted
 * label over the control, hairline separations, no numbered badges — the
 * controls themselves show what is chosen.
 */
function Step({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-hairline pt-5 first:border-t-0 first:pt-0">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-muted">
        {title}
      </h2>
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
 *   1. it opts the group in (the pre-hydration stylesheet paints the selection in
 *      the same sage accent the hydrated RateCards use);
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
  onAdopt,
  children,
}: {
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
    >
      {children}
    </div>
  );
}

export function BookingWidget({
  activity,
  initialRange,
  timeZone,
  preselect,
  stickyMobileCta = false,
}: BookingWidgetProps) {
  const router = useRouter();

  // One string identifies a board deep-link's exact selection; null when the URL
  // carries none. Compared against the persisted `appliedDeepLink` to decide
  // whether the params are a fresh board tap or a Back-nav over an old link.
  const deepLinkKey =
    preselect && (preselect.date || preselect.slot || preselect.rate)
      ? [preselect.date ?? '', preselect.slot ?? '', preselect.rate ?? ''].join('|')
      : null;

  // Resolve the initial selection once, lazily, during the first render (this is
  // a client component; nothing here is SSR'd). Precedence: a NEW deep link →
  // the persisted Back-restore → fresh defaults. A deep link already applied
  // once defers to the restore, so Back from checkout keeps the guest's own
  // later edits instead of resetting them to what the board link said.
  const initRef = useRef<{ sel: PersistedSelection; fromDeepLink: boolean } | null>(null);
  if (initRef.current === null) {
    const persisted = restoreSelection(activity.id);
    const todayIso = timeZone ? operatorDayISO(timeZone) : formatISODate(new Date());
    const linkIsNew = deepLinkKey !== null && persisted?.appliedDeepLink !== deepLinkKey;
    if (linkIsNew) {
      // A past (or malformed) date is stale — drop it and the slot that rode on
      // it, silently. The rate can still preselect on its own.
      const dateOk =
        preselect?.date && /^\d{4}-\d{2}-\d{2}$/.test(preselect.date) && preselect.date >= todayIso
          ? preselect.date
          : null;
      initRef.current = {
        fromDeepLink: true,
        sel: {
          rateId: preselect?.rate ?? null,
          dateISO: dateOk,
          timeslotId: dateOk ? (preselect?.slot ?? null) : null,
          quantity: persisted?.quantity ?? Math.max(1, activity.minParticipants),
          appliedDeepLink: deepLinkKey,
        },
      };
    } else {
      initRef.current = {
        fromDeepLink: false,
        sel: persisted ?? {
          rateId: null,
          dateISO: null,
          timeslotId: null,
          quantity: Math.max(1, activity.minParticipants),
          appliedDeepLink: deepLinkKey,
        },
      };
    }
  }
  const restored = initRef.current.sel;

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

  // The timeslot the guest had chosen (or the board linked), if any. Held until
  // TimeSlotPicker loads the day and re-selects the matching slot (which sets the
  // real `slot` object above and clears this). Only used to drive the picker's
  // controlled selection — a sold-out or vanished id simply never resolves.
  const [pendingTimeslotId, setPendingTimeslotId] = useState<string | null>(
    restored.timeslotId,
  );

  /*
   * Board tap → checkout is the two-tap promise: when a deep link lands, bring
   * the booking card into view with the preselection already made, so the next
   * tap is the CTA. Focus moves to the card (tabIndex -1) so a keyboard/screen
   * reader arrives at the thing the tap chose, not at the top of the document.
   */
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!initRef.current?.fromDeepLink) return;
    const node = cardRef.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: 'nearest' });
  }, []);

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

  /*
   * The itemized all-in total (DESIGN.md speed mechanics #3): the same
   * `calculatePricing` the checkout and the booking run, fed the operator's fee
   * specs from the activity detail, so the number above the CTA is the number
   * the guest will be charged. Older API responses without fee specs degrade to
   * an honestly-labelled pre-fee subtotal.
   */
  const fees = useMemo(() => activity.fees ?? [], [activity.fees]);
  const hasFees = fees.length > 0;
  const pricing = useMemo(
    () =>
      rate
        ? calculatePricing({
            items: [{ unitPriceCents: rate.priceCents, quantity: clampedQty }],
            fees,
          })
        : null,
    [rate, clampedQty, fees],
  );
  const totalCents = pricing?.totalCents ?? 0;

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

  // "See tomorrow →" from the time picker's ended-for-today empty state: the
  // operator's next calendar day, same bucketing as everything else here.
  const selectTomorrow = () => {
    const iso = timeZone ? operatorDayISO(timeZone, 1) : formatISODate(new Date(Date.now() + 86_400_000));
    handleSelectDate(startOfDay(parseISO(iso)));
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
      appliedDeepLink: restored.appliedDeepLink ?? deepLinkKey,
    });
  }, [
    activity.id,
    rate?.id,
    date,
    effectiveTimeslotId,
    clampedQty,
    restored.appliedDeepLink,
    deepLinkKey,
  ]);

  const proceedToCheckout = () => {
    if (!ready || !rate || !date || !slot) return;
    // Save the exact selection first, so pressing Back from checkout restores it.
    persistSelection(activity.id, {
      rateId: rate.id,
      dateISO: formatISODate(date),
      timeslotId: slot.timeslotId,
      quantity: clampedQty,
      appliedDeepLink: restored.appliedDeepLink ?? deepLinkKey,
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

  // The mobile bar's helper label/action when the selection is incomplete: name
  // the next choice and bring it on screen.
  const nextStepLabel = !rate ? 'Choose a rate' : !date ? 'Pick a date' : 'Choose a time';
  const scrollToCard = () => {
    cardRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  return (
    <>
      <div
        ref={cardRef}
        tabIndex={-1}
        className="rounded-card border border-hairline bg-surface p-5 shadow-card outline-none sm:p-6"
      >
        <div className="flex flex-col gap-6">
          <Step title="Rate">
            <PreHydrationRadioGroup onAdopt={adoptPreHydrationRate}>
              <RateCards
                rates={activity.rates}
                selectedRateId={rate?.id ?? null}
                onSelect={setRate}
              />
            </PreHydrationRadioGroup>
          </Step>

          <Step title="Date">
            <AvailabilityCalendar
              activityId={activity.id}
              selectedDate={date}
              onSelectDate={handleSelectDate}
              initialRange={initialRange}
              timeZone={timeZone}
            />
          </Step>

          <Step title="Time">
            {date ? (
              <TimeSlotPicker
                activityId={activity.id}
                date={date}
                selectedTimeslotId={effectiveTimeslotId}
                onSelect={handleSelectSlot}
                timeZone={timeZone}
                onSeeTomorrow={selectTomorrow}
              />
            ) : (
              <p className="rounded-lg border border-hairline bg-surface px-3 py-3 text-sm text-muted">
                Pick a date above to see available times.
              </p>
            )}
          </Step>

          {/* Quantity */}
          <section className="border-t border-hairline pt-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted">
                  Guests
                </h2>
                <p className="tnum mt-0.5 text-xs text-muted">
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
                  className="flex h-11 w-11 items-center justify-center rounded-lg border border-hairline text-lg font-semibold text-ink transition-colors hover:bg-bg disabled:cursor-not-allowed disabled:opacity-30"
                >
                  −
                </button>
                <span
                  className="tnum min-w-[2ch] text-center text-lg font-semibold text-ink"
                  aria-live="polite"
                >
                  {clampedQty}
                </span>
                <button
                  type="button"
                  aria-label="Increase guests"
                  disabled={clampedQty >= maxQty}
                  onClick={() => setQuantity((q) => Math.min(maxQty, q + 1))}
                  className="flex h-11 w-11 items-center justify-center rounded-lg border border-hairline text-lg font-semibold text-ink transition-colors hover:bg-bg disabled:cursor-not-allowed disabled:opacity-30"
                >
                  +
                </button>
              </div>
            </div>
          </section>

          {/* Itemized all-in total + CTA */}
          <div className="border-t border-hairline pt-5">
            {ready && rate && date && slot && pricing ? (
              <dl className="mb-4 space-y-1.5 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">When</dt>
                  <dd className="text-right font-medium text-ink">
                    {formatLongDate(date)}
                    <br />
                    <span className="tnum font-normal text-muted">{formatTime(slot.datetime)}</span>
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">
                    {rate.name} · <span className="tnum">{formatUSD(rate.priceCents)}</span> ×{' '}
                    <span className="tnum">{clampedQty}</span>
                  </dt>
                  <dd className="tnum font-medium text-ink">{formatUSD(pricing.subtotalCents)}</dd>
                </div>
                {pricing.taxCents > 0 && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Tax</dt>
                    <dd className="tnum text-muted">{formatUSD(pricing.taxCents)}</dd>
                  </div>
                )}
                {pricing.processingFeeCents > 0 && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Processing fee</dt>
                    <dd className="tnum text-muted">{formatUSD(pricing.processingFeeCents)}</dd>
                  </div>
                )}
                <div className="mt-1 flex justify-between gap-3 border-t border-hairline pt-2">
                  <dt className="font-semibold text-ink">
                    {hasFees ? 'Total' : 'Estimated total'}
                    {hasFees && <span className="ml-1.5 font-normal text-muted">all-in</span>}
                  </dt>
                  <dd className="tnum text-base font-semibold text-ink">
                    {formatUSD(totalCents)}
                  </dd>
                </div>
                {!hasFees && (
                  <p className="pt-1 text-xs text-muted">
                    Applicable taxes and fees are added at payment.
                  </p>
                )}
              </dl>
            ) : (
              <p className="mb-4 text-sm text-muted">
                Select a rate, date, and time to continue.
              </p>
            )}

            {/* The one sage action on this page. White on sage at 16px/600. */}
            <button
              type="button"
              disabled={!ready}
              onClick={proceedToCheckout}
              className="flex min-h-[52px] w-full items-center justify-center rounded-lg bg-accent px-4 py-3 text-center text-base font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {ready ? (
                <span className="flex w-full items-center justify-between gap-3">
                  <span>Continue to checkout</span>
                  <span className="tnum">{formatUSD(totalCents)}</span>
                </span>
              ) : (
                'Continue to checkout'
              )}
            </button>
          </div>
        </div>
      </div>

      {/*
        Mobile-only sticky bar: price + the CTA, per DESIGN.md's detail-page
        anatomy — the same pattern as the checkout's bar. `aria-hidden` and out
        of the tab order on purpose: the in-flow CTA above already gives
        assistive tech and keyboards the action; this is a reach aid for a thumb,
        and duplicating it into the accessibility tree would announce the same
        control twice.
      */}
      {stickyMobileCta && (
      <div
        aria-hidden
        className="fixed inset-x-0 bottom-0 z-30 border-t border-hairline bg-surface px-4 py-3 shadow-[0_-2px_14px_rgba(43,36,28,0.06)] lg:hidden"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="tnum text-base font-semibold leading-tight text-ink">
              {ready
                ? formatUSD(totalCents)
                : activity.fromPriceCents != null
                  ? `from ${formatUSD(activity.fromPriceCents)}`
                  : '—'}
            </p>
            <p className="truncate text-xs text-muted">
              {ready
                ? hasFees
                  ? 'Taxes and fees included'
                  : 'Before taxes and fees'
                : 'All-in pricing'}
            </p>
          </div>
          <button
            type="button"
            tabIndex={-1}
            onClick={ready ? proceedToCheckout : scrollToCard}
            className="shrink-0 rounded-lg bg-accent px-5 py-3 text-[15px] font-semibold text-white transition-opacity hover:opacity-90"
          >
            {ready ? 'Continue to checkout' : nextStepLabel}
          </button>
        </div>
      </div>
      )}
    </>
  );
}

export default BookingWidget;
