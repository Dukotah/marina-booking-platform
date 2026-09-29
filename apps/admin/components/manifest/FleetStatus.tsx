'use client';

import { useEffect, useId, useRef, useState, useTransition, type RefObject } from 'react';
import { AlertTriangle, CalendarClock, Check, Phone, Ship, Wrench, X } from 'lucide-react';
import {
  bringBoatBackInService,
  previewBoatDowntime,
  takeBoatOutOfService,
  type BoatImpact,
} from '../../app/manifest/actions';
import type { FleetBoat } from '../../app/manifest/data';

/**
 * Fleet status — every boat, jet ski and patio the marina actually runs, each
 * one by NAME, with the one control that moves it between "on the water" and
 * "out of service".
 *
 * This replaced the pooled-Resource panel, which operated on shared-capacity
 * counts ("take 1 of 4 units down") and therefore never named a specific boat
 * or let you pick one out of the rotation. Here each Activity IS the boat, so
 * taking "the Canoe" down means exactly that: its days in the window stop
 * selling (activity blackouts + closed unbooked departures — see the mechanism
 * comment in app/manifest/actions.ts), and Back in service reverses it
 * precisely. Pools for genuinely shared gear remain under Settings → Resources.
 *
 * Interaction rules carried over from the old panel:
 *  1. **Never strand a guest quietly.** The consequence — how many trips are
 *     already booked in the window and who to ring — is shown BEFORE the
 *     confirm button, and a window with booked trips gates the confirm behind
 *     an explicit acknowledgement. The server re-checks either way.
 *  2. **It has to work one-handed.** Controls are at least 44px tall and the
 *     layout wraps in a single column at 360px.
 */

const GROUPS: Array<{ label: string; match: (category: string) => boolean }> = [
  { label: 'Boats', match: (c) => c === 'BOAT' },
  { label: 'Watercraft', match: (c) => c === 'WATERCRAFT' },
  { label: 'Patios & venues', match: (c) => c === 'PATIO' },
  { label: 'Other listings', match: () => true },
];

/** "Thu, Aug 29" from a YYYY-MM-DD calendar date, read as a local day (never UTC). */
function dayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m || !d) return isoDate;
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(y, m - 1, d, 12));
}

/** "Sat, Aug 29 · 10:00 AM" from an ISO instant. */
function tripLabel(startISO: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(startISO));
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function FleetStatus({
  boats,
  canManage,
  /** The manifest's day — the sensible default for "out from". */
  defaultFromISO,
  /** Today in the OPERATOR's timezone, resolved on the server. A dock in Sonoma
   *  is a day behind UTC after 5pm, and dates must not flip on a UTC boundary. */
  todayISO,
}: {
  boats: FleetBoat[];
  canManage: boolean;
  defaultFromISO: string;
  todayISO: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [focusAfterId, setFocusAfterId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * Moving a boat between states replaces the button that was pressed with a
   * different one, which destroys the focused element and drops focus to
   * <body> — a keyboard user is silently returned to the top of the page. Put
   * focus on the control that replaced it and say what happened, the same
   * contract the check-in list holds. (2.4.3, 4.1.3)
   *
   * `boats` is a dependency on purpose: the replacement button only exists once
   * the revalidated server data has landed, which can be a render later than
   * the transition settling.
   */
  useEffect(() => {
    if (!focusAfterId || isPending) return;
    const next = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-fleet-focus="${focusAfterId}"]`,
    );
    if (!next) return;
    next.focus();
    setFocusAfterId(null);
  }, [focusAfterId, isPending, boats]);

  function bringBack(boat: FleetBoat) {
    setError(null);
    setAnnouncement('');
    startTransition(async () => {
      const res = await bringBoatBackInService(boat.id);
      if (!res.ok) {
        setError(res.error ?? 'Could not put it back in service.');
        return;
      }
      setAnnouncement(`${boat.name} is back in service and bookable again.`);
      setFocusAfterId(boat.id);
    });
  }

  if (boats.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        No active boats or listings yet. Add them under Catalog to run fleet status from here.
      </p>
    );
  }

  return (
    <div ref={listRef}>
      <p className="text-sm text-slate-600">
        {canManage
          ? 'Taking a boat out of service closes its open departures for that window straight away — guests cannot book it until you bring it back.'
          : 'What is on the water. Ask an owner or manager to change it.'}
      </p>

      {/* Present from first render so an insertion into it is actually announced. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {/* role="alert": a failed write is async with no focus move, so nothing else
          would tell a screen-reader user the tap did not take. (4.1.3) */}
      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800"
        >
          {error}
        </p>
      ) : null}

      {groupBoats(boats).map((group) => (
        <div key={group.label} className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            {group.label}
          </h3>
          <ul className="mt-1 divide-y divide-slate-100">
            {group.boats.map((boat) => (
              <BoatRow
                key={boat.id}
                boat={boat}
                canManage={canManage}
                defaultFromISO={defaultFromISO}
                todayISO={todayISO}
                isOpen={openId === boat.id}
                isBusy={isPending}
                onToggle={() => {
                  setError(null);
                  setOpenId((current) => (current === boat.id ? null : boat.id));
                }}
                onClose={() => setOpenId(null)}
                onBringBack={() => bringBack(boat)}
                onDone={(message) => {
                  setOpenId(null);
                  setAnnouncement(message);
                  setFocusAfterId(boat.id);
                }}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function groupBoats(boats: FleetBoat[]): Array<{ label: string; boats: FleetBoat[] }> {
  const out = GROUPS.map((g) => ({ label: g.label, boats: [] as FleetBoat[] }));
  for (const boat of boats) {
    const index = GROUPS.findIndex((g) => g.match(boat.category));
    out[index].boats.push(boat);
  }
  return out.filter((g) => g.boats.length > 0);
}

function BoatRow({
  boat,
  canManage,
  defaultFromISO,
  todayISO,
  isOpen,
  isBusy,
  onToggle,
  onClose,
  onBringBack,
  onDone,
}: {
  boat: FleetBoat;
  canManage: boolean;
  defaultFromISO: string;
  todayISO: string;
  isOpen: boolean;
  isBusy: boolean;
  onToggle: () => void;
  onClose: () => void;
  onBringBack: () => void;
  onDone: (message: string) => void;
}) {
  const formId = useId();
  const outage = boat.outage;
  // The boat is DOWN today vs down starting a future day — both are "out of
  // service" states, but the dock reads them differently.
  const outLater = outage !== null && outage.fromISO > todayISO;

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: boat.color }}
              aria-hidden
            />
            <span className="break-words text-sm font-semibold text-slate-900">{boat.name}</span>
            {/* Text in every badge — status never rides on the fill colour. (1.4.1) */}
            {outage ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                {outLater ? (
                  <>
                    <CalendarClock className="h-3 w-3" aria-hidden /> Out from{' '}
                    {dayLabel(outage.fromISO)}
                  </>
                ) : (
                  <>
                    <Wrench className="h-3 w-3" aria-hidden /> Out of service
                  </>
                )}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                <Ship className="h-3 w-3" aria-hidden /> On the water
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-slate-600">
            {boat.hasActiveRule
              ? 'Repeating schedule is generating departures'
              : 'One-off departures only (no repeating schedule)'}
          </p>
          {outage ? (
            <p className="mt-1.5 text-xs text-slate-700">
              <span className="font-semibold">Reason:</span> {outage.reason || '—'}
              <span className="text-slate-600">
                {' '}
                · out {outLater ? 'from' : 'since'} {dayLabel(outage.fromISO)}
              </span>
              {outage.untilISO ? (
                <span className="text-slate-600"> · expected back {dayLabel(outage.untilISO)}</span>
              ) : (
                <span className="text-slate-600"> · no return date — bring it back by hand</span>
              )}
            </p>
          ) : null}
        </div>

        {canManage ? (
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            {outage ? (
              <button
                type="button"
                data-fleet-focus={boat.id}
                disabled={isBusy}
                onClick={onBringBack}
                aria-label={`Put ${boat.name} back in service — bookable again`}
                // emerald-700, not emerald-600: white on emerald-600 is 3.79:1. (1.4.3)
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 sm:min-h-0 sm:flex-none sm:py-2"
              >
                <Check className="h-4 w-4" aria-hidden /> Back in service
              </button>
            ) : (
              <button
                type="button"
                data-fleet-focus={boat.id}
                disabled={isBusy}
                onClick={onToggle}
                aria-expanded={isOpen}
                aria-controls={formId}
                aria-label={`Take ${boat.name} out of service`}
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 sm:min-h-0 sm:flex-none sm:py-2"
              >
                <Wrench className="h-4 w-4" aria-hidden /> Out of service
              </button>
            )}
          </div>
        ) : null}
      </div>

      {/* Kept mounted-but-empty so aria-controls always resolves to a real element. */}
      <div id={formId}>
        {isOpen && canManage && !outage ? (
          <TakeOutForm
            boat={boat}
            defaultFromISO={defaultFromISO}
            todayISO={todayISO}
            onCancel={onClose}
            onDone={onDone}
          />
        ) : null}
      </div>
    </li>
  );
}

type Stage = { kind: 'form' } | { kind: 'confirm'; impact: BoatImpact };

function TakeOutForm({
  boat,
  defaultFromISO,
  todayISO,
  onCancel,
  onDone,
}: {
  boat: FleetBoat;
  defaultFromISO: string;
  todayISO: string;
  onCancel: () => void;
  onDone: (message: string) => void;
}) {
  const ids = useId();
  const reasonId = `${ids}-reason`;
  const fromId = `${ids}-from`;
  const untilId = `${ids}-until`;
  const reasonHintId = `${ids}-reason-hint`;
  const untilHintId = `${ids}-until-hint`;

  const [reason, setReason] = useState('');
  // The manifest can be showing a past day; "out from" can never usefully be
  // in the past, so a stale default is clamped to today up front.
  const [fromISO, setFromISO] = useState(defaultFromISO < todayISO ? todayISO : defaultFromISO);
  const [untilISO, setUntilISO] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const firstFieldRef = useRef<HTMLInputElement>(null);
  const impactRef = useRef<HTMLDivElement>(null);

  // Opening the panel puts the keyboard in it, rather than leaving focus on a
  // toggle above content that just appeared below it. (2.4.3)
  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  // The consequence is the point of that step, so it is where focus lands. (2.4.3)
  useEffect(() => {
    if (stage.kind === 'confirm') impactRef.current?.focus();
  }, [stage]);

  /** Any edit invalidates a preview that was computed from the old values. */
  function edited<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setAcknowledged(false);
      setStage({ kind: 'form' });
    };
  }

  function check() {
    setError(null);
    startTransition(async () => {
      const res = await previewBoatDowntime(boat.id, fromISO, untilISO || null);
      if (!res.ok || !res.impact) {
        setError(res.error ?? 'Could not work out what this would affect.');
        return;
      }
      setStage({ kind: 'confirm', impact: res.impact });
    });
  }

  function commit(impact: BoatImpact) {
    setError(null);
    startTransition(async () => {
      const res = await takeBoatOutOfService({
        activityId: boat.id,
        reason,
        fromISO,
        untilISO: untilISO || null,
        acknowledgeBookings: acknowledged,
      });
      if (!res.ok) {
        setError(res.error ?? 'Could not take it out of service.');
        // The server re-checked and found something the preview did not — show it.
        if (res.impact) setStage({ kind: 'confirm', impact: res.impact });
        return;
      }
      onDone(
        `${boat.name} out of service ${
          impact.untilISO
            ? `${dayLabel(impact.fromISO)} to ${dayLabel(impact.untilISO)}`
            : `from ${dayLabel(impact.fromISO)}`
        }. ${impact.slotsToClose} open ${plural(
          impact.slotsToClose,
          'departure',
          'departures',
        )} withdrawn.`,
      );
    });
  }

  const trimmedReason = reason.trim();

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <h4 className="text-sm font-semibold text-slate-900">Take {boat.name} out of service</h4>

      {error ? (
        <p
          role="alert"
          className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={reasonId} className="text-sm font-medium text-slate-700">
            What is wrong with it
          </label>
          <input
            ref={firstFieldRef}
            id={reasonId}
            type="text"
            value={reason}
            maxLength={200}
            aria-describedby={reasonHintId}
            placeholder="Engine will not start"
            onChange={(e) => edited(setReason)(e.target.value)}
            className="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-900 shadow-sm outline-none placeholder:text-slate-500 focus:border-slate-500 focus:ring-2 focus:ring-slate-300"
          />
          <p id={reasonHintId} className="text-xs text-slate-600">
            The crew and the office both read this.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={fromId} className="text-sm font-medium text-slate-700">
            Out from
          </label>
          <input
            id={fromId}
            type="date"
            value={fromISO}
            min={todayISO}
            onChange={(e) => edited(setFromISO)(e.target.value)}
            className="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-900 shadow-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-300"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={untilId} className="text-sm font-medium text-slate-700">
            Back by (optional)
          </label>
          <input
            id={untilId}
            type="date"
            value={untilISO}
            min={fromISO}
            aria-describedby={untilHintId}
            onChange={(e) => edited(setUntilISO)(e.target.value)}
            className="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-900 shadow-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-300"
          />
          <p id={untilHintId} className="text-xs text-slate-600">
            With a date, those days re-open on their own when it passes. Without one, the next{' '}
            90 days close and you bring it back by hand.
          </p>
        </div>
      </div>

      {stage.kind === 'confirm' ? (
        <ImpactPanel
          panelRef={impactRef}
          impact={stage.impact}
          acknowledged={acknowledged}
          onAcknowledge={setAcknowledged}
        />
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {stage.kind === 'form' ? (
          <button
            type="button"
            disabled={isPending || !trimmedReason || !fromISO}
            onClick={check}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50 sm:min-h-0 sm:flex-none sm:py-2"
          >
            <AlertTriangle className="h-4 w-4" aria-hidden /> Check what this affects
          </button>
        ) : (
          <button
            type="button"
            disabled={isPending || (stage.impact.bookedTrips > 0 && !acknowledged)}
            onClick={() => commit(stage.impact)}
            className={`inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-semibold text-white disabled:opacity-50 sm:min-h-0 sm:flex-none sm:py-2 ${
              stage.impact.bookedTrips > 0
                ? // rose-700, not rose-600: white on rose-600 is 4.32:1. (1.4.3)
                  'bg-rose-700 hover:bg-rose-800'
                : 'bg-slate-900 hover:bg-slate-700'
            }`}
          >
            <Wrench className="h-4 w-4" aria-hidden />
            {isPending
              ? 'Saving…'
              : stage.impact.bookedTrips > 0
                ? 'Take it out anyway'
                : 'Take it out of service'}
          </button>
        )}
        <button
          type="button"
          disabled={isPending}
          onClick={onCancel}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 sm:min-h-0 sm:flex-none sm:py-2"
        >
          <X className="h-4 w-4" aria-hidden /> Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The consequence, stated before it is committed.
 *
 * `tabIndex={-1}` + `role="status"`: this block appears in response to a button
 * press with no navigation, so a screen-reader user gets it twice over —
 * announced on insertion, and again as the place focus lands. It is the
 * difference between "you pressed a button" and "two booked parties lose their
 * boat". (4.1.3, 2.4.3)
 */
function ImpactPanel({
  impact,
  acknowledged,
  onAcknowledge,
  panelRef,
}: {
  impact: BoatImpact;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
  panelRef: RefObject<HTMLDivElement>;
}) {
  const hasBooked = impact.bookedTrips > 0;
  const windowLabel = impact.openEnded
    ? `from ${dayLabel(impact.fromISO)} onwards (next ${impact.horizonDays} days close)`
    : `${dayLabel(impact.fromISO)} to ${dayLabel(impact.untilISO as string)}`;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="status"
      className={`mt-3 rounded-lg border p-3 outline-none ${
        hasBooked ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50'
      }`}
    >
      <p
        className={`flex items-start gap-2 text-sm font-semibold ${
          hasBooked ? 'text-rose-800' : 'text-emerald-800'
        }`}
      >
        {hasBooked ? (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        ) : (
          <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        )}
        <span>
          {hasBooked
            ? `${impact.bookedTrips} booked ${plural(
                impact.bookedTrips,
                'trip loses',
                'trips lose',
              )} ${impact.activityName} in that window.`
            : 'No booked trip is affected.'}
        </span>
      </p>

      <p className={`mt-1.5 text-xs ${hasBooked ? 'text-rose-800' : 'text-emerald-800'}`}>
        {impact.activityName} closes {windowLabel}: {impact.slotsToClose} open{' '}
        {plural(impact.slotsToClose, 'departure comes', 'departures come')} off sale
        {impact.hasActiveRule ? ' and its repeating schedule stops generating there' : ''}. Booked
        departures are never cancelled from here.
      </p>

      {hasBooked ? (
        <>
          <p className="mt-2 text-xs font-semibold text-rose-800">
            Ring {impact.guestsTotal === 1 ? 'this guest' : 'these guests'} before you confirm
            {impact.guestsTotal > impact.guests.length
              ? ` (${impact.guests.length} of ${impact.guestsTotal} shown)`
              : ''}
            :
          </p>
          <ul className="mt-1 space-y-1">
            {impact.guests.map((b) => (
              <li key={b.orderItemId} className="text-xs text-rose-900">
                <span className="font-semibold">{b.customerName}</span> · #{b.orderNumber} ·{' '}
                {tripLabel(b.startISO)} · {b.seats} {plural(b.seats, 'seat', 'seats')}
                {b.customerPhone ? (
                  <>
                    {' · '}
                    <a
                      href={`tel:${b.customerPhone}`}
                      aria-label={`Call ${b.customerName} on ${b.customerPhone}`}
                      className="inline-flex items-center gap-1 py-1.5 font-medium underline underline-offset-2"
                    >
                      <Phone className="h-3 w-3" aria-hidden /> {b.customerPhone}
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>

          {/* The guard against quietly stranding guests: the confirm button stays
              disabled until somebody says, in as many words, that they know. */}
          <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border border-rose-300 bg-white p-2.5">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => onAcknowledge(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-400 text-rose-700 focus:ring-rose-500"
            />
            <span className="text-xs font-medium text-slate-800">
              I know {impact.guestsTotal} booked {plural(impact.guestsTotal, 'trip', 'trips')}{' '}
              {plural(impact.guestsTotal, 'needs', 'need')} moving or refunding, and I will sort it
              out.
            </span>
          </label>
        </>
      ) : null}
    </div>
  );
}
