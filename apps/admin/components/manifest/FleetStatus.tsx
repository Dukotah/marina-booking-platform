'use client';

import { useEffect, useId, useRef, useState, useTransition, type RefObject } from 'react';
import { AlertTriangle, Check, Phone, Ship, Wrench, X } from 'lucide-react';
import {
  markResourceDown,
  previewResourceDowntime,
  returnResourceToService,
  type FleetImpact,
} from '../../app/manifest/actions';

/**
 * Fleet status — what is on the water, what is down, and the one control that moves a
 * boat between those two states.
 *
 * This exists because taking a boat out of service used to be Settings -> Resources ->
 * edit a number, which is not a thing a man standing on a dock on a Saturday morning
 * with a dead outboard is going to do. It is the same write (Resource
 * .out_of_service_qty, through the same settings action — see app/manifest/actions.ts),
 * moved to the screen he is already looking at.
 *
 * Two rules shape the interaction:
 *
 *  1. **Never oversell quietly.** Shrinking a pool can leave a paid guest without a
 *     boat, so the panel shows the consequence — how many trips are already booked in
 *     that window, how short the remaining fleet would be at its busiest moment, and
 *     who to ring — BEFORE it offers a confirm button. When there is a shortfall the
 *     confirm is gated behind an explicit acknowledgement, and the server re-checks
 *     rather than trusting the form.
 *  2. **It has to work one-handed.** Every control is at least 44px tall, the layout
 *     is a single column that wraps rather than scrolls sideways at 360px, and the
 *     panel never sends him to another screen to finish the job.
 */

/** The last recorded downtime for a pool that currently has units down. */
export interface FleetDownNote {
  reason: string;
  /** Operator-local YYYY-MM-DD it went out of service. */
  fromISO: string | null;
  /** Operator-local YYYY-MM-DD it is expected back, when one was given. */
  untilISO: string | null;
  /** When the note was recorded. */
  recordedAtISO: string;
}

/** One shared-resource pool as the dock needs to see it. */
export interface FleetResourceRow {
  id: string;
  name: string;
  quantity: number;
  seatCapacity: number;
  outOfServiceQty: number;
  isActive: boolean;
  /** Activities that draw on this pool, for "what does taking it down affect". */
  activityNames: string[];
  down: FleetDownNote | null;
}

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

/** Bookable seats a pool provides, mirroring the booking engine's own arithmetic. */
function poolSeats(r: FleetResourceRow): number {
  return Math.max(0, r.quantity - r.outOfServiceQty) * r.seatCapacity;
}

export function FleetStatus({
  resources,
  canManage,
  /** The manifest's day — the sensible default for "out from". */
  defaultFromISO,
  /** Today in the OPERATOR's timezone, resolved on the server. A dock in Sonoma is a
   *  day behind UTC after 5pm, and "was due back" must not flip on a UTC boundary. */
  todayISO,
}: {
  resources: FleetResourceRow[];
  canManage: boolean;
  defaultFromISO: string;
  todayISO: string;
}) {
  const headingId = useId();
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [focusAfterId, setFocusAfterId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const listRef = useRef<HTMLUListElement>(null);

  /**
   * Moving a boat between states replaces the button that was pressed with a different
   * one, which destroys the focused element and drops focus to <body> — a keyboard
   * user is silently returned to the top of the page. Put focus on the control that
   * replaced it and say what happened, the same contract the check-in list holds.
   * (2.4.3, 4.1.3)
   *
   * `resources` is a dependency on purpose: the replacement button only exists once
   * the revalidated server data has landed, which can be a render later than the
   * transition settling. Holding `focusAfterId` until a control is actually found
   * means the attempt survives that gap instead of quietly missing.
   */
  useEffect(() => {
    if (!focusAfterId || isPending) return;
    const next = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-fleet-focus="${focusAfterId}"]`,
    );
    if (!next) return;
    next.focus();
    setFocusAfterId(null);
  }, [focusAfterId, isPending, resources]);

  function bringBack(row: FleetResourceRow) {
    setError(null);
    setAnnouncement('');
    startTransition(async () => {
      const res = await returnResourceToService(row.id);
      if (!res.ok) {
        setError(res.error ?? 'Could not put it back in service.');
        return;
      }
      setAnnouncement(
        `${row.name} back in service — all ${row.quantity} ${plural(row.quantity, 'unit', 'units')} available.`,
      );
      setFocusAfterId(row.id);
    });
  }

  if (resources.length === 0) {
    return (
      <section
        aria-labelledby={headingId}
        className="mb-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <h2 id={headingId} className="text-xs font-semibold uppercase tracking-wide text-slate-600">
          Fleet status
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          No boats, jet skis or other shared equipment are set up yet, so there is nothing to take
          out of service. Add them under{' '}
          <a
            href="/settings/resources"
            className="font-medium text-sky-800 underline underline-offset-2 hover:text-sky-900"
          >
            Settings, Shared resources
          </a>
          .
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="mb-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <h2 id={headingId} className="text-xs font-semibold uppercase tracking-wide text-slate-600">
        Fleet status
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        {canManage
          ? 'Taking a unit out of service stops those seats being sold straight away. It stays out until you put it back.'
          : 'What is on the water today. Ask an owner or manager to change it.'}
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

      <ul ref={listRef} className="mt-2 divide-y divide-slate-100">
        {resources.map((row) => (
          <FleetRow
            key={row.id}
            row={row}
            canManage={canManage}
            defaultFromISO={defaultFromISO}
            todayISO={todayISO}
            isOpen={openId === row.id}
            isBusy={isPending}
            onToggle={() => {
              setError(null);
              setOpenId((current) => (current === row.id ? null : row.id));
            }}
            onClose={() => setOpenId(null)}
            onBringBack={() => bringBack(row)}
            onDone={(message) => {
              setOpenId(null);
              setAnnouncement(message);
              setFocusAfterId(row.id);
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function FleetRow({
  row,
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
  row: FleetResourceRow;
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
  const inService = Math.max(0, row.quantity - row.outOfServiceQty);
  const down = row.outOfServiceQty;

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-words text-sm font-semibold text-slate-900">{row.name}</span>
            {/* Text in every badge — status never rides on the fill colour. (1.4.1) */}
            {down > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                <Wrench className="h-3 w-3" aria-hidden /> {down} down
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                <Ship className="h-3 w-3" aria-hidden /> All in service
              </span>
            )}
            {!row.isActive ? (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                Capacity not enforced
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-slate-600">
            {inService} of {row.quantity} in service · {poolSeats(row)}{' '}
            {plural(poolSeats(row), 'seat', 'seats')} bookable
            {row.activityNames.length > 0 ? ` · ${row.activityNames.join(', ')}` : ''}
          </p>
          {down > 0 && row.down ? <DownNote note={row.down} todayISO={todayISO} /> : null}
        </div>

        {canManage ? (
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            {down > 0 ? (
              <button
                type="button"
                data-fleet-focus={row.id}
                disabled={isBusy}
                onClick={onBringBack}
                aria-label={`Put ${row.name} back in service — all ${row.quantity} ${plural(
                  row.quantity,
                  'unit',
                  'units',
                )} available again`}
                // emerald-700, not emerald-600: white on emerald-600 is 3.79:1. (1.4.3)
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 sm:min-h-0 sm:flex-none sm:py-2"
              >
                <Check className="h-4 w-4" aria-hidden /> Back in service
              </button>
            ) : null}
            <button
              type="button"
              {...(down === 0 ? { 'data-fleet-focus': row.id } : {})}
              disabled={isBusy || inService === 0}
              onClick={onToggle}
              aria-expanded={isOpen}
              aria-controls={formId}
              aria-label={`Take a ${row.name} unit out of service`}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 sm:min-h-0 sm:flex-none sm:py-2"
            >
              <Wrench className="h-4 w-4" aria-hidden /> Mark down
            </button>
          </div>
        ) : null}
      </div>

      {/* Kept mounted-but-empty so aria-controls always resolves to a real element. */}
      <div id={formId}>
        {isOpen && canManage ? (
          <MarkDownForm
            row={row}
            inService={inService}
            defaultFromISO={defaultFromISO}
            onCancel={onClose}
            onDone={onDone}
          />
        ) : null}
      </div>
    </li>
  );
}

/** The recorded reason + dates for a pool that is currently down. */
function DownNote({ note, todayISO }: { note: FleetDownNote; todayISO: string }) {
  // Calendar-date comparison, and YYYY-MM-DD sorts lexicographically the same way it
  // sorts chronologically, so no Date object is needed (or wanted — one would drag a
  // timezone back into a question that is purely about days).
  const overdue = note.untilISO !== null && note.untilISO < todayISO;

  return (
    <p className="mt-1.5 text-xs text-slate-700">
      <span className="font-semibold">Reason:</span> {note.reason}
      {note.fromISO ? <span className="text-slate-600"> · out since {dayLabel(note.fromISO)}</span> : null}
      {note.untilISO ? (
        <span className={overdue ? 'font-semibold text-rose-800' : 'text-slate-600'}>
          {' '}
          · {overdue ? 'was due back' : 'expected back'} {dayLabel(note.untilISO)}
          {/* Not colour alone: the word "still" is the signal, the colour is a hint. */}
          {overdue ? ' — still marked down' : ''}
        </span>
      ) : null}
    </p>
  );
}

type Stage =
  | { kind: 'form' }
  | { kind: 'confirm'; impact: FleetImpact };

function MarkDownForm({
  row,
  inService,
  defaultFromISO,
  onCancel,
  onDone,
}: {
  row: FleetResourceRow;
  inService: number;
  defaultFromISO: string;
  onCancel: () => void;
  onDone: (message: string) => void;
}) {
  const ids = useId();
  const unitsId = `${ids}-units`;
  const reasonId = `${ids}-reason`;
  const fromId = `${ids}-from`;
  const untilId = `${ids}-until`;
  const reasonHintId = `${ids}-reason-hint`;
  const untilHintId = `${ids}-until-hint`;

  const [units, setUnits] = useState(1);
  const [reason, setReason] = useState('');
  const [fromISO, setFromISO] = useState(defaultFromISO);
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

  // The consequence is the point of this step, so it is where focus lands. (2.4.3)
  useEffect(() => {
    if (stage.kind === 'confirm') impactRef.current?.focus();
  }, [stage]);

  /** Any edit invalidates a preview that was computed from the old numbers. */
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
      const res = await previewResourceDowntime(row.id, units, fromISO, untilISO || null);
      if (!res.ok || !res.impact) {
        setError(res.error ?? 'Could not work out what this would affect.');
        return;
      }
      setStage({ kind: 'confirm', impact: res.impact });
    });
  }

  function commit(impact: FleetImpact) {
    setError(null);
    startTransition(async () => {
      const res = await markResourceDown({
        resourceId: row.id,
        units,
        reason,
        fromISO,
        untilISO: untilISO || null,
        acknowledgeOversell: acknowledged,
      });
      if (!res.ok) {
        setError(res.error ?? 'Could not take it out of service.');
        // The server re-checked and found something the preview did not — show it.
        if (res.impact) setStage({ kind: 'confirm', impact: res.impact });
        return;
      }
      onDone(
        `${row.name}: ${units} ${plural(units, 'unit', 'units')} out of service. ${
          impact.seatsAfter
        } ${plural(impact.seatsAfter, 'seat', 'seats')} still bookable.`,
      );
    });
  }

  const trimmedReason = reason.trim();

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <h3 className="text-sm font-semibold text-slate-900">
        Take {row.name} out of service
      </h3>

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
          <label htmlFor={unitsId} className="text-sm font-medium text-slate-700">
            How many units
          </label>
          <input
            ref={firstFieldRef}
            id={unitsId}
            type="number"
            inputMode="numeric"
            min={1}
            max={inService}
            step={1}
            value={Number.isNaN(units) ? '' : units}
            onChange={(e) => edited(setUnits)(e.target.valueAsNumber)}
            className="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-900 shadow-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-300"
          />
          <p className="text-xs text-slate-600">
            {inService} of {row.quantity} {plural(inService, 'is', 'are')} on the water now.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={reasonId} className="text-sm font-medium text-slate-700">
            What is wrong with it
          </label>
          <input
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
          {/* Said plainly because it is the one thing this screen cannot do: there is
              no scheduled sweep, so a date here is a reminder and the window we count
              affected trips over — not an automatic return. */}
          <p id={untilHintId} className="text-xs text-slate-600">
            We will not put it back on its own — tap Back in service when it is fixed.
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
            disabled={isPending || !trimmedReason || !(units >= 1)}
            onClick={check}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50 sm:min-h-0 sm:flex-none sm:py-2"
          >
            <AlertTriangle className="h-4 w-4" aria-hidden /> Check what this affects
          </button>
        ) : (
          <button
            type="button"
            disabled={isPending || (stage.impact.shortfallSeats > 0 && !acknowledged)}
            onClick={() => commit(stage.impact)}
            className={`inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-semibold text-white disabled:opacity-50 sm:min-h-0 sm:flex-none sm:py-2 ${
              stage.impact.shortfallSeats > 0
                ? // rose-700, not rose-600: white on rose-600 is 4.32:1. (1.4.3)
                  'bg-rose-700 hover:bg-rose-800'
                : 'bg-slate-900 hover:bg-slate-700'
            }`}
          >
            <Wrench className="h-4 w-4" aria-hidden />
            {isPending
              ? 'Saving…'
              : stage.impact.shortfallSeats > 0
                ? 'Take it out anyway'
                : `Take ${units} out of service`}
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
 * `tabIndex={-1}` + `role="status"`: this block appears in response to a button press
 * with no navigation, so a screen-reader user gets it twice over — announced on
 * insertion, and again as the place focus lands. It is the difference between "you
 * pressed a button" and "three guests will not have a boat". (4.1.3, 2.4.3)
 */
function ImpactPanel({
  impact,
  acknowledged,
  onAcknowledge,
  panelRef,
}: {
  impact: FleetImpact;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
  panelRef: RefObject<HTMLDivElement>;
}) {
  const short = impact.shortfallSeats > 0;
  const windowLabel = impact.openEnded
    ? `from ${dayLabel(impact.fromISO)} onwards (checked ${impact.horizonDays} days ahead)`
    : `${dayLabel(impact.fromISO)} to ${dayLabel(impact.untilISO as string)}`;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="status"
      className={`mt-3 rounded-lg border p-3 outline-none ${
        short ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50'
      }`}
    >
      <p className={`flex items-start gap-2 text-sm font-semibold ${short ? 'text-rose-800' : 'text-emerald-800'}`}>
        {short ? (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        ) : (
          <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        )}
        <span>
          {short
            ? `This would leave ${impact.shortfallSeats} booked ${plural(
                impact.shortfallSeats,
                'seat',
                'seats',
              )} without a boat.`
            : 'No booked trip loses its boat.'}
        </span>
      </p>

      <p className={`mt-1.5 text-xs ${short ? 'text-rose-800' : 'text-emerald-800'}`}>
        {impact.bookedTrips} {plural(impact.bookedTrips, 'trip is', 'trips are')} booked on{' '}
        {impact.resourceName} {windowLabel}. At the busiest moment they need {impact.peakSeats}{' '}
        {plural(impact.peakSeats, 'seat', 'seats')}; you would have {impact.seatsAfter} (down from{' '}
        {impact.seatsBefore}).
      </p>

      {impact.poolInactive ? (
        <p className="mt-1.5 text-xs font-medium text-slate-700">
          Heads up: this pool is switched off in settings, so its capacity is not being enforced on
          new bookings either way.
        </p>
      ) : null}

      {short ? (
        <>
          <p className="mt-2 text-xs font-semibold text-rose-800">
            Ring {impact.atRiskTotal === 1 ? 'this guest' : 'these guests'} before you confirm
            {impact.atRiskTotal > impact.atRisk.length
              ? ` (${impact.atRisk.length} of ${impact.atRiskTotal} shown)`
              : ''}
            :
          </p>
          <ul className="mt-1 space-y-1">
            {impact.atRisk.map((b) => (
              <li key={b.orderItemId} className="text-xs text-rose-900">
                <span className="font-semibold">{b.customerName}</span> · {b.activityName} ·{' '}
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

          {/* The guard against a silent oversell: the confirm button stays disabled
              until somebody says, in as many words, that they know. */}
          <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border border-rose-300 bg-white p-2.5">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => onAcknowledge(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-400 text-rose-700 focus:ring-rose-500"
            />
            <span className="text-xs font-medium text-slate-800">
              I know {impact.atRiskTotal} booked {plural(impact.atRiskTotal, 'trip', 'trips')}{' '}
              {plural(impact.atRiskTotal, 'needs', 'need')} moving or refunding, and I will sort it
              out.
            </span>
          </label>
        </>
      ) : null}
    </div>
  );
}
