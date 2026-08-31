'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { AlertTriangle, Check, UserX, RotateCcw, Phone, Users, Ship } from 'lucide-react';
import { formatUSD } from '../../lib/format';
import { cn } from '../../lib/cn';
import { localMinutesOfDay, todayIsoIn } from './tz';
import { readableTextColor, type ManifestBooking, type ManifestRow } from './types';
import { CapacityBar } from './CapacityBar';
import {
  checkInOrderItem,
  undoCheckInOrderItem,
  markNoShowOrderItem,
  undoNoShowOrderItem,
} from '../../app/manifest/actions';

/** "9:00 AM" from minutes-since-midnight (already operator-local). */
function timeLabel(startMin: number): string {
  const h24 = Math.floor(startMin / 60);
  const m = startMin % 60;
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function lateLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${String(m).padStart(2, '0')} min`;
}

/**
 * A single departure on the day schedule: one activity's timeslot, its capacity,
 * its scheduled guide(s) and the guests booked on it (empty slots included, so the
 * operator can see what is still sellable).
 */
interface Departure {
  key: string;
  activityId: string;
  activityName: string;
  color: string;
  startMin: number;
  /** Wall-clock return (minutes since midnight) of the latest-ending booking, or
   *  null when the slot is empty. */
  returnMin: number | null;
  /** True when that latest booking runs past midnight into the next day. */
  endsNextDay: boolean;
  capacityBooked: number;
  capacityTotal: number;
  guides: { id: string; name: string }[];
  bookings: ManifestBooking[];
}

/** Word + tone for a slot's fill — never colour alone. (WCAG 1.4.1) */
function fillState(booked: number, total: number): { label: string; tone: 'open' | 'filling' | 'full' } {
  if (total <= 0 || booked <= 0) return { label: 'Open — no bookings yet', tone: 'open' };
  if (booked >= total) return { label: 'Full', tone: 'full' };
  const remaining = total - booked;
  if (booked / total >= 0.8) return { label: `Nearly full — ${remaining} left`, tone: 'filling' };
  return { label: `${remaining} spot${remaining === 1 ? '' : 's'} left`, tone: 'open' };
}

/**
 * The day schedule: every timeslot for the chosen day as a roomy, time-ordered card,
 * grouped under big time-block headers. Built for a non-technical operator to read at a
 * glance and check guests in with one tap — the "run the whole day from one screen" view
 * that answers Singenuity's text wall and FareHarbor's manifest without the smoosh.
 */
export function DaySchedule({
  rows,
  timeZone,
  isoDate,
  showCheckIn = true,
}: {
  rows: ManifestRow[];
  /** Operator IANA timezone — the clock "overdue" is measured against. */
  timeZone: string;
  /** The day on screen, YYYY-MM-DD; overdue only applies when it is today. */
  isoDate: string;
  /** Show one-tap check-in / no-show controls (on for the ops manifest). */
  showCheckIn?: boolean;
}) {
  const [onlyBooked, setOnlyBooked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [focusAfterId, setFocusAfterId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);

  // Operator-local "now", filled in after mount so server and client agree, then
  // ticked each minute so a boat that goes overdue at 2:01 says so at 2:01.
  const [now, setNow] = useState<{ isoDate: string; minutes: number } | null>(null);
  useEffect(() => {
    function tick() {
      setNow({ isoDate: todayIsoIn(timeZone), minutes: localMinutesOfDay(new Date(), timeZone) });
    }
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, [timeZone]);

  // Flatten activity rows into one departure per timeslot, carrying that slot's guests.
  const departures: Departure[] = useMemo(() => {
    const out: Departure[] = [];
    for (const row of rows) {
      const byId = new Map<string, ManifestBooking[]>();
      for (const b of row.bookings) {
        const list = byId.get(b.timeslotId);
        if (list) list.push(b);
        else byId.set(b.timeslotId, [b]);
      }
      for (const slot of row.slots) {
        const bookings = (byId.get(slot.timeslotId) ?? []).slice().sort((a, b) => a.startMin - b.startMin);
        // Latest end across the slot's bookings, measured on an absolute scale so an
        // overnight rate (returns next day) sorts after a same-day one.
        const ends = bookings.map((b) => (b.endsNextDay ? b.returnMin + 24 * 60 : b.returnMin));
        const maxEnd = ends.length ? Math.max(...ends) : null;
        out.push({
          key: slot.timeslotId,
          activityId: row.activityId,
          activityName: row.activityName,
          color: row.color,
          startMin: slot.startMin,
          returnMin: maxEnd !== null ? maxEnd % (24 * 60) : null,
          endsNextDay: maxEnd !== null && maxEnd >= 24 * 60,
          capacityBooked: slot.capacityBooked,
          capacityTotal: slot.capacityTotal,
          guides: slot.guides.map((g) => ({ id: g.assignmentId, name: g.guideName || g.guideEmail })),
          bookings,
        });
      }
    }
    out.sort((a, b) => a.startMin - b.startMin || a.activityName.localeCompare(b.activityName));
    return out;
  }, [rows]);

  const visible = onlyBooked ? departures.filter((d) => d.bookings.length > 0) : departures;

  // Group into time blocks keyed by start minute, in order.
  const blocks = useMemo(() => {
    const map = new Map<number, Departure[]>();
    for (const d of visible) {
      const g = map.get(d.startMin);
      if (g) g.push(d);
      else map.set(d.startMin, [d]);
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  }, [visible]);

  function overdueBy(b: ManifestBooking): number | null {
    if (!now || now.isoDate !== isoDate) return null;
    if (b.status !== 'CHECKED_IN') return null;
    const late = now.minutes - b.endMin;
    return late > 0 ? late : null;
  }

  function run(id: string, success: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    setAnnouncement('');
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setError(res.error ?? 'Could not update the booking.');
        return;
      }
      setAnnouncement(success);
      setFocusAfterId(id);
    });
  }

  useEffect(() => {
    if (!focusAfterId || isPending) return;
    rootRef.current
      ?.querySelector<HTMLButtonElement>(`[data-booking-action="${focusAfterId}"]`)
      ?.focus();
    setFocusAfterId(null);
  }, [focusAfterId, isPending]);

  const hasAny = departures.length > 0;

  return (
    <div ref={rootRef}>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {/* Toolbar: the collapse-empties toggle (Peek's core anti-clutter control). */}
      {hasAny ? (
        <div className="mb-4 flex items-center justify-between gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              checked={onlyBooked}
              onChange={(e) => setOnlyBooked(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
            />
            Only show timeslots with bookings
          </label>
          <span className="text-sm text-slate-600">
            {visible.length} {visible.length === 1 ? 'departure' : 'departures'}
          </span>
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-700"
        >
          {error}
        </p>
      ) : null}

      {!hasAny ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <Ship className="mx-auto h-10 w-10 text-slate-300" aria-hidden />
          <h3 className="mt-3 text-base font-semibold text-slate-700">No timeslots this day</h3>
          <p className="mt-1 text-sm text-slate-600">
            Nothing is scheduled. Pick another day, or add timeslots from Activities.
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-600">
          No booked departures this day. Untick the filter to see every open timeslot.
        </div>
      ) : (
        <div className="space-y-8">
          {blocks.map(([startMin, group]) => (
            <section key={startMin} aria-label={`Departures at ${timeLabel(startMin)}`}>
              {/* Big time-block header — the anchor a busy day is read against. */}
              <h3 className="mb-3 flex items-baseline gap-3 text-xl font-bold tabular-nums text-slate-900">
                {timeLabel(startMin)}
                <span className="text-sm font-medium text-slate-500">
                  {group.length} {group.length === 1 ? 'departure' : 'departures'}
                </span>
              </h3>
              <div className="space-y-4">
                {group.map((d) => (
                  <DepartureCard
                    key={d.key}
                    d={d}
                    showCheckIn={showCheckIn}
                    isPending={isPending}
                    overdueBy={overdueBy}
                    run={run}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function DepartureCard({
  d,
  showCheckIn,
  isPending,
  overdueBy,
  run,
}: {
  d: Departure;
  showCheckIn: boolean;
  isPending: boolean;
  overdueBy: (b: ManifestBooking) => number | null;
  run: (id: string, success: string, action: () => Promise<{ ok: boolean; error?: string }>) => void;
}) {
  const fg = readableTextColor(d.color);
  const fill = fillState(d.capacityBooked, d.capacityTotal);
  const fillTone =
    fill.tone === 'full'
      ? 'bg-rose-100 text-rose-800'
      : fill.tone === 'filling'
        ? 'bg-amber-100 text-amber-900'
        : 'bg-emerald-100 text-emerald-800';

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Card header: activity, capacity, guide. Time lives in the block header above. */}
      <div className="border-b border-slate-100 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-2.5">
            <span
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold"
              style={{ backgroundColor: d.color, color: fg }}
              aria-hidden
            >
              {d.activityName.slice(0, 2).toUpperCase()}
            </span>
            <div>
              <div className="text-base font-semibold text-slate-900">{d.activityName}</div>
              {d.returnMin !== null ? (
                <div className="text-sm text-slate-600">
                  back by{' '}
                  <span className="font-semibold tabular-nums text-slate-700">
                    {timeLabel(d.returnMin)}
                    {d.endsNextDay ? ' (next day)' : ''}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
          <div className="text-right">
            {d.guides.length > 0 ? (
              <div className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                <Users className="h-3.5 w-3.5" aria-hidden />
                {d.guides.map((g) => g.name).join(', ')}
              </div>
            ) : (
              <div className="text-xs font-medium text-slate-500">No guide assigned</div>
            )}
          </div>
        </div>

        {/* Capacity: bar + literal count + a status word (never colour alone). */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-sm font-semibold tabular-nums text-slate-800">
            {d.capacityBooked} / {d.capacityTotal} booked
          </span>
          <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', fillTone)}>
            {fill.label}
          </span>
          <div className="min-w-[8rem] flex-1">
            <CapacityBar booked={d.capacityBooked} total={d.capacityTotal} />
          </div>
        </div>
      </div>

      {/* Guests on this departure, or an open-slot line. */}
      {d.bookings.length === 0 ? (
        <div className="px-4 py-3 text-sm text-slate-500 sm:px-5">
          No bookings yet — this timeslot is open to sell.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {d.bookings.map((b) => {
            const late = overdueBy(b);
            return (
              <li
                key={b.orderItemId}
                className={cn(
                  'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-5',
                  late !== null
                    ? 'bg-rose-50/60'
                    : b.status === 'CHECKED_IN'
                      ? 'bg-emerald-50/40'
                      : b.status === 'NO_SHOW'
                        ? 'bg-slate-50 text-slate-500'
                        : '',
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-medium text-slate-900">{b.customerName}</span>
                    <span className="inline-flex items-center gap-1 text-sm text-slate-600">
                      <Users className="h-3.5 w-3.5" aria-hidden /> {b.quantity}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                    <span className="font-mono">{b.orderNumber}</span>
                    {b.customerPhone ? (
                      <a
                        href={`tel:${b.customerPhone}`}
                        aria-label={`Call ${b.customerName} on ${b.customerPhone}`}
                        className="inline-flex items-center gap-1 py-1 hover:text-slate-800"
                      >
                        <Phone className="h-3 w-3" aria-hidden /> {b.customerPhone}
                      </a>
                    ) : null}
                    {b.waiverSigned ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
                        <Check className="h-3 w-3" aria-hidden /> Waiver signed
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-800">
                        Waiver needed
                      </span>
                    )}
                    {b.balanceDueCents > 0 ? (
                      <span className="font-semibold tabular-nums text-rose-700">
                        {formatUSD(b.balanceDueCents)} due
                      </span>
                    ) : (
                      <span className="text-slate-600">Paid</span>
                    )}
                    {late !== null ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 font-bold text-rose-900">
                        <AlertTriangle className="h-3 w-3" aria-hidden /> {lateLabel(late)} overdue
                      </span>
                    ) : null}
                  </div>
                </div>

                {showCheckIn ? (
                  <div className="flex items-center gap-1.5">
                    {b.status === 'UPCOMING' ? (
                      <>
                        <button
                          type="button"
                          disabled={isPending}
                          data-booking-action={b.orderItemId}
                          onClick={() =>
                            run(b.orderItemId, `Checked in ${b.customerName}.`, () =>
                              checkInOrderItem(b.orderItemId),
                            )
                          }
                          aria-label={`Check in ${b.customerName}, ${d.activityName}`}
                          className="inline-flex min-h-11 items-center justify-center gap-1 rounded-md bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                        >
                          <Check className="h-4 w-4" aria-hidden /> Check in
                        </button>
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() =>
                            run(b.orderItemId, `Marked ${b.customerName} as a no-show.`, () =>
                              markNoShowOrderItem(b.orderItemId),
                            )
                          }
                          aria-label={`Mark no-show: ${b.customerName}, ${d.activityName}`}
                          className="inline-flex min-h-11 items-center justify-center gap-1 rounded-md border border-slate-300 px-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                        >
                          <UserX className="h-4 w-4" aria-hidden />
                          <span className="hidden sm:inline">No-show</span>
                        </button>
                      </>
                    ) : b.status === 'CHECKED_IN' ? (
                      <button
                        type="button"
                        disabled={isPending}
                        data-booking-action={b.orderItemId}
                        onClick={() =>
                          run(b.orderItemId, `Check-in undone for ${b.customerName}.`, () =>
                            undoCheckInOrderItem(b.orderItemId),
                          )
                        }
                        aria-label={`Undo check-in for ${b.customerName}`}
                        className="inline-flex min-h-11 items-center justify-center gap-1 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      >
                        <RotateCcw className="h-4 w-4" aria-hidden /> Undo
                      </button>
                    ) : b.status === 'NO_SHOW' ? (
                      <button
                        type="button"
                        disabled={isPending}
                        data-booking-action={b.orderItemId}
                        onClick={() =>
                          run(b.orderItemId, `No-show undone for ${b.customerName}.`, () =>
                            undoNoShowOrderItem(b.orderItemId),
                          )
                        }
                        aria-label={`Undo no-show for ${b.customerName}`}
                        className="inline-flex min-h-11 items-center justify-center gap-1 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      >
                        <RotateCcw className="h-4 w-4" aria-hidden /> Undo
                      </button>
                    ) : (
                      <span className="text-sm text-slate-500">{b.status.toLowerCase()}</span>
                    )}
                  </div>
                ) : (
                  <StatusPill status={b.status} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: ManifestBooking['status'] }) {
  const map: Record<string, { label: string; cls: string }> = {
    UPCOMING: { label: 'Upcoming', cls: 'bg-sky-50 text-sky-700' },
    CHECKED_IN: { label: 'Checked in', cls: 'bg-emerald-50 text-emerald-700' },
    NO_SHOW: { label: 'No-show', cls: 'bg-slate-100 text-slate-600' },
    CANCELLED: { label: 'Cancelled', cls: 'bg-rose-50 text-rose-700' },
    COMPLETED: { label: 'Completed', cls: 'bg-slate-100 text-slate-600' },
  };
  const s = map[status] ?? { label: status, cls: 'bg-slate-100 text-slate-600' };
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${s.cls}`}>{s.label}</span>;
}
