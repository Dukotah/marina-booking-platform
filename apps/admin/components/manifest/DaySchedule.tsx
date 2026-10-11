'use client';

import { useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  CheckCheck,
  MessageSquare,
  UserX,
  RotateCcw,
  Phone,
  Users,
  Ship,
  Plus,
  Clock,
  Send,
  X,
} from 'lucide-react';
import { formatUSD } from '../../lib/format';
import { cn } from '../../lib/cn';
import { Button, Badge, Card, Input, Select, FieldLabel, type BadgeTone } from '../ui';
import { localMinutesOfDay, todayIsoIn } from './tz';
import {
  readableTextColor,
  bookingMatchesFilter,
  type ManifestBooking,
  type ManifestRow,
  type ManifestWaitlistEntry,
  type ManifestStatFilter,
} from './types';
import { CapacityBar } from './CapacityBar';
import {
  checkInOrderItem,
  undoCheckInOrderItem,
  markNoShowOrderItem,
  undoNoShowOrderItem,
  notifyWaitlistAction,
  removeWaitlistEntryAction,
  checkInAllOnTimeslot,
  noShowAllOnTimeslot,
  broadcastToTimeslotAction,
} from '../../app/manifest/actions';
import { addOrderChargeAction, collectBalanceAction } from '../../app/orders/actions';
import { ReservationCard } from '../calendar/ReservationCard';

/** "9:00 AM" from minutes-since-midnight (already operator-local). */
function timeLabel(startMin: number): string {
  const h24 = Math.floor(startMin / 60);
  const m = startMin % 60;
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/** Toolbar text naming the active stat filter, so it's clear why the day is short. */
function filterToolbarLabel(filter: ManifestStatFilter): string {
  switch (filter) {
    case 'arriving':
      return 'Showing arrivals still to come';
    case 'checkedIn':
      return 'Showing checked-in guests';
    case 'due':
      return 'Showing guests who owe a balance';
    case 'unsigned':
      return 'Showing guests with an unsigned waiver';
    case 'waiting':
      return 'Showing full departures with a waitlist';
  }
}

/** Empty-state line when a stat filter matches nothing on the day. */
function filterEmptyLabel(filter: ManifestStatFilter): string {
  switch (filter) {
    case 'arriving':
      return 'Everyone has arrived — no one is still to come.';
    case 'checkedIn':
      return 'No one is checked in yet.';
    case 'due':
      return 'No balances to collect.';
    case 'unsigned':
      return 'Every waiver is signed.';
    case 'waiting':
      return 'No one is on a waitlist.';
  }
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
  /** Guests waiting on this (sold-out) slot, oldest first = notify order. */
  waitlist: ManifestWaitlistEntry[];
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
  filter = null,
}: {
  rows: ManifestRow[];
  /** Operator IANA timezone — the clock "overdue" is measured against. */
  timeZone: string;
  /** The day on screen, YYYY-MM-DD; overdue only applies when it is today. */
  isoDate: string;
  /** Show one-tap check-in / no-show controls (on for the ops manifest). */
  showCheckIn?: boolean;
  /**
   * Active stat-row filter, or null for the whole day. A booking-level filter
   * (arriving/checkedIn/due/unsigned) narrows each departure to the matching guests
   * and drops departures left empty; 'waiting' keeps only full slots that have a
   * waitlist. Driven by the glanceable stat row above.
   */
  filter?: ManifestStatFilter | null;
}) {
  // Booked-only by default: a marina day can carry 100+ sellable timeslots, and a
  // wall of "Open — no bookings yet" cards buried the dozen departures that matter.
  // One untick still shows everything sellable.
  const [onlyBooked, setOnlyBooked] = useState(true);
  // The reservation card open for a clicked guest (null = closed).
  const [openItemId, setOpenItemId] = useState<string | null>(null);
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
      // Cancelled bookings ride along in the data (for the list view's toggle) but a
      // departure card is about who is actually coming.
      for (const b of row.bookings.filter((x) => x.status !== 'CANCELLED')) {
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
          waitlist: slot.waitlist,
        });
      }
    }
    out.sort((a, b) => a.startMin - b.startMin || a.activityName.localeCompare(b.activityName));
    return out;
  }, [rows]);

  // Apply the stat-row filter first, then the collapse-empties toggle. A
  // booking-level filter narrows each departure's guest list and drops the
  // departures left empty; 'waiting' keeps only full slots that still have a line.
  const filtered: Departure[] = useMemo(() => {
    if (!filter) return departures;
    if (filter === 'waiting') {
      return departures.filter(
        (d) => d.capacityTotal > 0 && d.capacityBooked >= d.capacityTotal && d.waitlist.length > 0,
      );
    }
    return departures
      .map((d) => ({ ...d, bookings: d.bookings.filter((b) => bookingMatchesFilter(b, filter)) }))
      .filter((d) => d.bookings.length > 0);
  }, [departures, filter]);

  // A stat filter already implies a reason to look, so the collapse-empties toggle
  // only prunes when the whole day is shown.
  const visible = !filter && onlyBooked ? filtered.filter((d) => d.bookings.length > 0) : filtered;

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

  function run(
    id: string,
    success: string,
    action: () => Promise<{ ok: boolean; error?: string; message?: string }>,
  ) {
    setError(null);
    setAnnouncement('');
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setError(res.error ?? res.message ?? 'Could not update the booking.');
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

      {/* Toolbar: the collapse-empties toggle (Peek's core anti-clutter control).
          While a stat filter is active the toggle is irrelevant — the list is
          already narrowed to the stat — so it steps aside for the count. */}
      {hasAny ? (
        <div className="mb-4 flex items-center justify-between gap-3">
          {filter ? (
            <span className="text-sm font-medium text-ink">{filterToolbarLabel(filter)}</span>
          ) : (
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium text-ink">
              <input
                type="checkbox"
                checked={onlyBooked}
                onChange={(e) => setOnlyBooked(e.target.checked)}
                className="h-4 w-4 rounded border-line-strong text-accent accent-accent focus:ring-focus"
              />
              Only show timeslots with bookings
            </label>
          )}
          <span className="text-sm text-ink-body">
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
        <div className="rounded-lg border border-dashed border-line-strong bg-surface p-12 text-center">
          <Ship className="mx-auto h-10 w-10 text-ink-muted" aria-hidden />
          <h3 className="mt-3 text-base font-semibold text-ink">No timeslots this day</h3>
          <p className="mt-1 text-sm text-ink-body">
            Nothing is scheduled. Pick another day, or add timeslots from Activities.
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong bg-surface p-10 text-center text-sm text-ink-body">
          {filter
            ? `${filterEmptyLabel(filter)} Tap the stat again to clear the filter.`
            : 'No booked departures this day. Untick the filter to see every open timeslot.'}
        </div>
      ) : (
        <div className="space-y-8">
          {blocks.map(([startMin, group]) => (
            <section key={startMin} aria-label={`Departures at ${timeLabel(startMin)}`}>
              {/* Big time-block header — the anchor a busy day is read against. */}
              <h3 className="mb-3 flex items-baseline gap-3 text-xl font-bold tabular-nums text-ink">
                {timeLabel(startMin)}
                <span className="text-sm font-medium text-ink-muted">
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
                    onOpenReservation={setOpenItemId}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {openItemId ? (
        <ReservationCard orderItemId={openItemId} onClose={() => setOpenItemId(null)} />
      ) : null}
    </div>
  );
}

function DepartureCard({
  d,
  showCheckIn,
  isPending,
  overdueBy,
  run,
  onOpenReservation,
}: {
  d: Departure;
  showCheckIn: boolean;
  isPending: boolean;
  overdueBy: (b: ManifestBooking) => number | null;
  run: (id: string, success: string, action: () => Promise<{ ok: boolean; error?: string }>) => void;
  /** Open the click-to-edit reservation card for one booking. */
  onOpenReservation: (orderItemId: string) => void;
}) {
  const fg = readableTextColor(d.color);
  const fill = fillState(d.capacityBooked, d.capacityTotal);
  const fillBadgeTone =
    fill.tone === 'full' ? 'owed' : fill.tone === 'filling' ? 'waiting' : 'success';

  // Waiting list only matters when the slot is actually full — a chip + an
  // expandable panel to notify the next guest or remove someone from the line.
  const waiting = fill.tone === 'full' ? d.waitlist : [];
  const [waitlistOpen, setWaitlistOpen] = useState(false);

  return (
    <Card className="overflow-hidden">
      {/* Card header: activity, capacity, guide. Time lives in the block header above. */}
      <div className="border-b border-line px-4 py-3 sm:px-5">
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
              <div className="text-base font-semibold text-ink">{d.activityName}</div>
              {d.returnMin !== null ? (
                <div className="text-sm text-ink-body">
                  back by{' '}
                  <span className="font-semibold tabular-nums text-ink">
                    {timeLabel(d.returnMin)}
                    {d.endsNextDay ? ' (next day)' : ''}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
          <div className="text-right">
            {d.guides.length > 0 ? (
              <Badge tone="neutral">
                <Users className="h-3.5 w-3.5" aria-hidden />
                {d.guides.map((g) => g.name).join(', ')}
              </Badge>
            ) : (
              <div className="text-xs font-medium text-ink-muted">No guide assigned</div>
            )}
          </div>
        </div>

        {/* Capacity: bar + literal count + a status word (never colour alone). */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-sm font-semibold tabular-nums text-ink">
            {d.capacityBooked} / {d.capacityTotal} booked
          </span>
          <Badge tone={fillBadgeTone}>{fill.label}</Badge>
          {waiting.length > 0 ? (
            <button
              type="button"
              onClick={() => setWaitlistOpen((o) => !o)}
              aria-expanded={waitlistOpen}
              aria-label={`${waiting.length} on the waitlist for ${d.activityName} — ${
                waitlistOpen ? 'hide' : 'show'
              } the list`}
              className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Clock className="h-3 w-3" aria-hidden /> {waiting.length} waiting
            </button>
          ) : null}
          <div className="min-w-[8rem] flex-1">
            <CapacityBar booked={d.capacityBooked} total={d.capacityTotal} />
          </div>
        </div>

        {waiting.length > 0 && waitlistOpen ? (
          <WaitlistPanel timeslotId={d.key} entries={waiting} />
        ) : null}

        {showCheckIn && d.bookings.length > 0 ? (
          <SlotOps timeslotId={d.key} activityName={d.activityName} bookings={d.bookings} />
        ) : null}
      </div>

      {/* Guests on this departure, or an open-slot line. */}
      {d.bookings.length === 0 ? (
        <div className="px-4 py-3 text-sm text-ink-muted sm:px-5">
          No bookings yet — this timeslot is open to sell.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {d.bookings.map((b) => {
            const late = overdueBy(b);
            return (
              <li
                key={b.orderItemId}
                className={cn(
                  'px-4 py-3 sm:px-5',
                  late !== null
                    ? 'bg-rose-50/60'
                    : b.status === 'CHECKED_IN'
                      ? 'bg-emerald-50/40'
                      : b.status === 'NO_SHOW'
                        ? 'bg-surface-muted text-ink-muted'
                        : '',
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {/* The guest's name opens the reservation card — the calendar's
                        click-to-edit entry point. A button (not a link) so Enter/Space
                        work and it announces as opening a dialog. */}
                    <button
                      type="button"
                      onClick={() => onOpenReservation(b.orderItemId)}
                      aria-haspopup="dialog"
                      data-reservation-trigger={b.orderItemId}
                      aria-label={`Open reservation for ${b.customerName}, ${d.activityName}`}
                      className="cursor-pointer rounded text-base font-medium text-ink underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      {b.customerName}
                    </button>
                    <span className="inline-flex items-center gap-1 text-sm text-ink-body">
                      <Users className="h-3.5 w-3.5" aria-hidden /> {b.quantity}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-body">
                    <span className="font-mono">{b.orderNumber}</span>
                    {b.customerPhone ? (
                      <a
                        href={`tel:${b.customerPhone}`}
                        aria-label={`Call ${b.customerName} on ${b.customerPhone}`}
                        className="inline-flex items-center gap-1 py-1 hover:text-ink"
                      >
                        <Phone className="h-3 w-3" aria-hidden /> {b.customerPhone}
                      </a>
                    ) : null}
                    {b.waiverSigned ? (
                      <Badge tone="success">
                        <Check className="h-3 w-3" aria-hidden /> Waiver signed
                      </Badge>
                    ) : (
                      <Badge tone="waiver">Waiver needed</Badge>
                    )}
                    {b.balanceDueCents > 0 ? (
                      <span className="font-semibold tabular-nums text-rose-700">
                        {formatUSD(b.balanceDueCents)} due
                      </span>
                    ) : (
                      <span className="text-ink-body">Paid</span>
                    )}
                    {late !== null ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 font-semibold text-rose-700">
                        <AlertTriangle className="h-3 w-3" aria-hidden /> {lateLabel(late)} overdue
                      </span>
                    ) : null}
                  </div>
                </div>

                {showCheckIn ? (
                  <div className="flex items-center gap-1.5">
                    {b.status === 'UPCOMING' ? (
                      <>
                        <Button
                          variant="primary"
                          disabled={isPending}
                          data-booking-action={b.orderItemId}
                          onClick={() =>
                            run(b.orderItemId, `Checked in ${b.customerName}.`, () =>
                              checkInOrderItem(b.orderItemId),
                            )
                          }
                          aria-label={`Check in ${b.customerName}, ${d.activityName}`}
                        >
                          <Check className="h-4 w-4" aria-hidden /> Check in
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={isPending}
                          onClick={() =>
                            run(b.orderItemId, `Marked ${b.customerName} as a no-show.`, () =>
                              markNoShowOrderItem(b.orderItemId),
                            )
                          }
                          aria-label={`Mark no-show: ${b.customerName}, ${d.activityName}`}
                        >
                          <UserX className="h-4 w-4" aria-hidden />
                          <span className="hidden sm:inline">No-show</span>
                        </Button>
                      </>
                    ) : b.status === 'CHECKED_IN' ? (
                      <Button
                        variant="secondary"
                        disabled={isPending}
                        data-booking-action={b.orderItemId}
                        onClick={() =>
                          run(b.orderItemId, `Check-in undone for ${b.customerName}.`, () =>
                            undoCheckInOrderItem(b.orderItemId),
                          )
                        }
                        aria-label={`Undo check-in for ${b.customerName}`}
                      >
                        <RotateCcw className="h-4 w-4" aria-hidden /> Undo
                      </Button>
                    ) : b.status === 'NO_SHOW' ? (
                      <Button
                        variant="secondary"
                        disabled={isPending}
                        data-booking-action={b.orderItemId}
                        onClick={() =>
                          run(b.orderItemId, `No-show undone for ${b.customerName}.`, () =>
                            undoNoShowOrderItem(b.orderItemId),
                          )
                        }
                        aria-label={`Undo no-show for ${b.customerName}`}
                      >
                        <RotateCcw className="h-4 w-4" aria-hidden /> Undo
                      </Button>
                    ) : (
                      <span className="text-sm text-ink-muted">{b.status.toLowerCase()}</span>
                    )}
                  </div>
                ) : (
                  <StatusPill status={b.status} />
                )}
                </div>
                {showCheckIn ? (
                  <BookingCharge
                    orderId={b.orderId}
                    balanceDueCents={b.balanceDueCents}
                    run={run}
                    isPending={isPending}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/**
 * The waiting line for a sold-out departure: each guest oldest-first with a
 * PENDING/NOTIFIED badge, a "Notify next" button (emails the oldest PENDING up to
 * the open seats — a no-op while the slot is still full, which is the honest truth)
 * and a remove control. Notify goes through the API (owns Resend); removal is a
 * direct tenant-scoped delete.
 */
function WaitlistPanel({
  timeslotId,
  entries,
}: {
  timeslotId: string;
  entries: ManifestWaitlistEntry[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function notifyNext() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await notifyWaitlistAction(timeslotId);
      if (!res.ok) {
        setError(res.error ?? 'Could not notify the waitlist.');
        return;
      }
      setNotice(
        res.notified && res.notified > 0
          ? `Emailed ${res.notified} ${res.notified === 1 ? 'guest' : 'guests'} that a spot opened.`
          : 'No spot is open yet — nobody was emailed.',
      );
    });
  }

  function remove(entry: ManifestWaitlistEntry) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await removeWaitlistEntryAction(entry.id);
      if (!res.ok) {
        setError(res.error ?? 'Could not remove that guest.');
        return;
      }
      setNotice(`Removed ${entry.name} from the waitlist.`);
    });
  }

  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-amber-700">
          Waiting list
        </span>
        <Button variant="secondary" size="sm" disabled={isPending} onClick={notifyNext}>
          <Send className="h-3.5 w-3.5" aria-hidden /> Notify next
        </Button>
      </div>

      {error ? (
        <p role="alert" className="mb-2 text-xs font-medium text-rose-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mb-2 text-xs font-medium text-emerald-700">
          {notice}
        </p>
      ) : null}

      <ol className="space-y-1.5">
        {entries.map((e, i) => (
          <li key={e.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className="tabular-nums text-xs font-semibold text-amber-700">{i + 1}.</span>
              <span className="truncate font-medium text-ink">{e.name}</span>
              <Badge tone={e.status === 'NOTIFIED' ? 'success' : 'neutral'}>
                {e.status === 'NOTIFIED' ? 'Notified' : 'Pending'}
              </Badge>
            </span>
            <button
              type="button"
              disabled={isPending}
              onClick={() => remove(e)}
              aria-label={`Remove ${e.name} from the waitlist`}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line text-ink-muted hover:bg-surface hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Per-slot bulk ops + broadcast on a departure: "Check in all" / "No-show all"
 * the still-upcoming guests in one write, and "Message all" to email/text every
 * live booking on the slot (weather hold, dock moved, running late). Status ops
 * are tenant-scoped narrow updateMany; the broadcast rides the API choke points.
 * Self-contained transition + a router.refresh() so new statuses land in the UI.
 */
function SlotOps({
  timeslotId,
  activityName,
  bookings,
}: {
  timeslotId: string;
  activityName: string;
  bookings: ManifestBooking[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [body, setBody] = useState('');
  const [email, setEmail] = useState(true);
  const [sms, setSms] = useState(false);
  const panelId = useId();

  const upcomingCount = bookings.filter((b) => b.status === 'UPCOMING').length;
  // "Message all" addresses every non-cancelled seat (the data already excludes
  // cancelled), so it is offered whenever there is anyone on the departure.
  const liveCount = bookings.length;

  function runStatus(label: string, action: () => Promise<{ ok: boolean; error?: string; updated?: number }>) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setError(res.error ?? 'Could not update the departure.');
        return;
      }
      setNotice(
        res.updated && res.updated > 0
          ? `${label} ${res.updated} ${res.updated === 1 ? 'guest' : 'guests'}.`
          : 'Nobody was still upcoming — nothing changed.',
      );
      router.refresh();
    });
  }

  function sendBroadcast() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await broadcastToTimeslotAction({ timeslotId, body, email, sms });
      if (!res.ok) {
        setError(res.error ?? 'Could not send the message.');
        return;
      }
      setNotice(
        `Messaged ${res.delivered ?? 0} of ${res.recipients ?? 0} ${
          (res.recipients ?? 0) === 1 ? 'guest' : 'guests'
        } on this departure.`,
      );
      setBroadcastOpen(false);
      setBody('');
    });
  }

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {upcomingCount > 0 ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={isPending}
              onClick={() =>
                runStatus('Checked in', () => checkInAllOnTimeslot(timeslotId))
              }
              aria-label={`Check in all ${upcomingCount} upcoming guests on ${activityName}`}
            >
              <CheckCheck className="h-4 w-4" aria-hidden /> Check in all ({upcomingCount})
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={isPending}
              onClick={() => runStatus('Marked no-show', () => noShowAllOnTimeslot(timeslotId))}
              aria-label={`Mark all ${upcomingCount} upcoming guests as no-shows on ${activityName}`}
            >
              <UserX className="h-4 w-4" aria-hidden /> No-show all
            </Button>
          </>
        ) : null}
        {liveCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            aria-expanded={broadcastOpen}
            aria-controls={broadcastOpen ? panelId : undefined}
            onClick={() => setBroadcastOpen((o) => !o)}
          >
            <MessageSquare className="h-4 w-4" aria-hidden /> Message all
          </Button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs font-medium text-rose-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-2 text-xs font-medium text-emerald-700">
          {notice}
        </p>
      ) : null}

      {broadcastOpen ? (
        <div id={panelId} className="mt-2 space-y-2 rounded-lg border border-line bg-surface-muted p-3">
          <FieldLabel htmlFor={`${panelId}-body`}>
            Message everyone on this departure
          </FieldLabel>
          <textarea
            id={`${panelId}-body`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={1000}
            autoFocus
            placeholder="e.g. Heads up — we're on a short weather hold, back on the water by 2:30."
            className="block w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus"
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium text-ink-body">
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={email}
                onChange={(e) => setEmail(e.target.checked)}
                className="h-4 w-4 rounded border-line-strong text-accent accent-accent focus:ring-focus"
              />
              Email
            </label>
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={sms}
                onChange={(e) => setSms(e.target.checked)}
                className="h-4 w-4 rounded border-line-strong text-accent accent-accent focus:ring-focus"
              />
              Text (guests with a phone)
            </label>
          </div>
          <div className="flex gap-2 pt-1">
            <Button
              variant="primary"
              size="sm"
              disabled={isPending || !body.trim() || (!email && !sms)}
              onClick={sendBroadcast}
            >
              <Send className="h-3.5 w-3.5" aria-hidden /> Send to all
            </Button>
            <Button variant="secondary" size="sm" disabled={isPending} onClick={() => setBroadcastOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatusPill({ status }: { status: ManifestBooking['status'] }) {
  // Status color law: CHECKED_IN = emerald (success); UPCOMING/COMPLETED = slate
  // (quiet neutral); NO_SHOW/CANCELLED = cancelled slate / owed rose.
  const map: Record<string, { label: string; tone: BadgeTone }> = {
    UPCOMING: { label: 'Upcoming', tone: 'neutral' },
    CHECKED_IN: { label: 'Checked in', tone: 'success' },
    NO_SHOW: { label: 'No-show', tone: 'cancelled' },
    CANCELLED: { label: 'Cancelled', tone: 'owed' },
    COMPLETED: { label: 'Completed', tone: 'cancelled' },
  };
  const s = map[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/**
 * Post-trip charging on a reservation: add a fuel/cleaning/damage/late charge (the
 * boat came back, tank's half empty), which lands on the order's balance, then settle
 * that balance with cash or card right here. This is the manifest's real job once the
 * "utilization" novelty wears off — running the dock when boats return.
 */
export function BookingCharge({
  orderId,
  balanceDueCents,
  run,
  isPending,
}: {
  orderId: string;
  balanceDueCents: number;
  run: (
    id: string,
    success: string,
    action: () => Promise<{ ok: boolean; error?: string; message?: string }>,
  ) => void;
  isPending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('FUEL');
  const [note, setNote] = useState('');

  function submit() {
    const dollars = parseFloat(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) return;
    const cents = Math.round(dollars * 100);
    run(orderId, `Added ${category.toLowerCase()} charge of $${dollars.toFixed(2)}.`, () =>
      addOrderChargeAction({ orderId, category, label: note.trim() || undefined, amountCents: cents }),
    );
    setOpen(false);
    setAmount('');
    setNote('');
    setCategory('FUEL');
  }

  return (
    <div className="mt-2 border-t border-line pt-2">
      {balanceDueCents > 0 ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold tabular-nums text-rose-700">
            {formatUSD(balanceDueCents)} to collect
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={isPending}
            onClick={() =>
              run(orderId, 'Marked paid in cash.', () => collectBalanceAction({ orderId, method: 'CASH' }))
            }
          >
            Mark paid (cash)
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={isPending}
            onClick={() =>
              run(orderId, 'Charged the card on file.', () => collectBalanceAction({ orderId, method: 'CARD' }))
            }
          >
            Charge card
          </Button>
        </div>
      ) : null}

      {open ? (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <FieldLabel htmlFor="charge-amount">Amount</FieldLabel>
            <div className="flex h-11 items-center rounded-lg border border-line bg-surface px-3 shadow-sm focus-within:border-accent focus-within:ring-2 focus-within:ring-focus">
              <span className="text-ink-muted">$</span>
              <input
                id="charge-amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                aria-label="Charge amount in dollars"
                className="w-20 border-0 bg-transparent py-1.5 text-sm text-ink focus:outline-none focus:ring-0"
                autoFocus
              />
            </div>
          </div>
          <div>
            <FieldLabel htmlFor="charge-category">For</FieldLabel>
            <Select
              id="charge-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              aria-label="Charge category"
              className="w-auto"
            >
              <option value="FUEL">Fuel</option>
              <option value="CLEANING">Cleaning</option>
              <option value="DAMAGE">Damage</option>
              <option value="LATE">Late return</option>
              <option value="OTHER">Other</option>
            </Select>
          </div>
          <div className="min-w-[8rem] flex-1">
            <FieldLabel htmlFor="charge-note">Note (optional)</FieldLabel>
            <Input
              id="charge-note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. half tank"
              aria-label="Charge note"
            />
          </div>
          <div className="flex gap-1.5">
            <Button variant="primary" size="sm" disabled={isPending || !amount.trim()} onClick={submit}>
              Add
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add fuel / charge
        </Button>
      )}
    </div>
  );
}
