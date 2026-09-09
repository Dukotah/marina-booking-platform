'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Phone,
} from 'lucide-react';
import { formatUSD } from '../../lib/format';
import { cn } from '../../lib/cn';
import { localMinutesOfDay, todayIsoIn } from './tz';
import { SignLinkActions } from '../waiver/SignLinkActions';
import { BookingCharge } from './DaySchedule';
import type { ManifestRow, ManifestListItem } from './types';
import {
  checkInOrderItem,
  undoCheckInOrderItem,
  markNoShowOrderItem,
  undoNoShowOrderItem,
} from '../../app/manifest/actions';

/** The one-tap filters the summary bar drives. */
export type ManifestFilter = 'all' | 'unsigned' | 'due' | 'checkedin';

/** "8:00 AM" from minutes-since-midnight (already operator-local). */
function timeLabel(startMin: number): string {
  const h24 = Math.floor(startMin / 60);
  const m = startMin % 60;
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/** "2:00 PM", or "8:00 AM (next day)" for a rate that runs past midnight. */
function returnLabel(it: ManifestListItem): string {
  return `${timeLabel(it.returnMin)}${it.endsNextDay ? ' (next day)' : ''}`;
}

/** "25 min" / "1 hr 05 min" — how late a boat is, said the way a dock says it. */
function lateLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${String(m).padStart(2, '0')} min`;
}

/**
 * How a control names the booking it acts on. Thirty rows each render the same
 * buttons, so the accessible name must say *which* party is being acted on. (4.1.2)
 */
function bookingLabel(it: ManifestListItem): string {
  return `${it.customerName}, ${it.activityName} at ${timeLabel(it.startMin)}, back by ${returnLabel(
    it,
  )}`;
}

/** Does a booking match one of the summary-bar filters? Cancelled never matches. */
export function matchesFilter(it: ManifestListItem, filter: ManifestFilter): boolean {
  if (it.status === 'CANCELLED') return false;
  switch (filter) {
    case 'unsigned':
      return !it.waiverSigned && (it.status === 'UPCOMING' || it.status === 'CHECKED_IN');
    case 'due':
      return it.balanceDueCents > 0 && it.status !== 'NO_SHOW';
    case 'checkedin':
      return it.status === 'CHECKED_IN';
    default:
      return true;
  }
}

/**
 * The receptionist manifest: today's parties as one compact, time-ordered row each —
 * time · who + headcount · boat · waiver · balance · one-tap check-in. Everything
 * else the row used to shout (phone, order number, rate, sign-link QR, post-trip
 * charges, settle balance) lives one click away behind row expansion, and no-show /
 * undo sit in a per-row overflow menu. Past departures collapse into "Earlier today";
 * cancelled bookings hide behind a toggle.
 */
export function ManifestList({
  rows,
  timeZone,
  isoDate,
  signLinkBase,
  filter = 'all',
}: {
  rows: ManifestRow[];
  /** Operator IANA timezone — the lens "now" is measured through. */
  timeZone: string;
  /** The day being shown, YYYY-MM-DD. Overdue/"earlier" only mean anything today. */
  isoDate: string;
  /** Customer web base URL — unsigned rows get copy-link + QR in their detail. */
  signLinkBase: string;
  /** Active summary-bar filter. Anything but 'all' shows a flat, matching list. */
  filter?: ManifestFilter;
}) {
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [focusAfterId, setFocusAfterId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * Operator-local "now", set after mount and re-read every minute — null on the
   * first render so server and client HTML agree, then the interval keeps "overdue"
   * and the earlier-today fold honest without a reload.
   */
  const [now, setNow] = useState<{ isoDate: string; minutes: number } | null>(null);
  useEffect(() => {
    function tick() {
      const at = new Date();
      setNow({ isoDate: todayIsoIn(timeZone), minutes: localMinutesOfDay(at, timeZone) });
    }
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, [timeZone]);

  // Close any open overflow menu on an outside click or Escape.
  useEffect(() => {
    if (!menuFor) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-row-menu]')) setMenuFor(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuFor(null);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  const items: ManifestListItem[] = useMemo(() => {
    const flat = rows.flatMap((row) =>
      row.bookings.map((b) => ({
        ...b,
        activityId: row.activityId,
        activityName: row.activityName,
        color: row.color,
      })),
    );
    flat.sort((a, b) => a.startMin - b.startMin || a.activityName.localeCompare(b.activityName));
    return flat;
  }, [rows]);

  /** Minutes a checked-in boat is late past its return time, or null. */
  function overdueBy(it: ManifestListItem): number | null {
    if (!now || now.isoDate !== isoDate) return null;
    if (it.status !== 'CHECKED_IN') return null;
    const late = now.minutes - it.endMin;
    return late > 0 ? late : null;
  }

  const active = items.filter((it) => it.status !== 'CANCELLED');
  const cancelled = items.filter((it) => it.status === 'CANCELLED');
  const overdueCount = active.filter((it) => overdueBy(it) !== null).length;
  const isToday = now !== null && now.isoDate === isoDate;

  // With a filter on, the list is flat: "3 unsigned waivers" must show all three,
  // wherever they sit in the day. Without one, past departures fold away — except an
  // overdue boat, which is precisely the row staff must not lose.
  const filtered = filter !== 'all';
  const visible = filtered ? active.filter((it) => matchesFilter(it, filter)) : active;
  const earlier =
    !filtered && isToday
      ? visible.filter((it) => it.startMin < now!.minutes && overdueBy(it) === null)
      : [];
  const earlierIds = new Set(earlier.map((it) => it.orderItemId));
  const upNext = visible.filter((it) => !earlierIds.has(it.orderItemId));

  function run(
    orderItemId: string,
    success: string,
    action: () => Promise<{ ok: boolean; error?: string; message?: string }>,
  ) {
    setError(null);
    setAnnouncement('');
    setMenuFor(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setError(res.error ?? res.message ?? 'Could not update the booking.');
        return;
      }
      setAnnouncement(success);
      setFocusAfterId(orderItemId);
    });
  }

  useEffect(() => {
    // After a write the pressed control may be gone (Check in → chip); focus lands on
    // the row's always-present overflow button, which holds the undo. (2.4.3)
    if (!focusAfterId || isPending) return;
    const next = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-booking-action="${focusAfterId}"]`,
    );
    next?.focus();
    setFocusAfterId(null);
  }, [focusAfterId, isPending]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
        No bookings for this day yet.
      </div>
    );
  }

  const rowProps = {
    isPending,
    signLinkBase,
    expanded,
    toggleExpanded,
    menuFor,
    setMenuFor,
    overdueBy,
    run,
  };

  return (
    <div ref={listRef} className="overflow-visible rounded-lg border border-slate-200 bg-white">
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {error ? (
        <p
          role="alert"
          className="border-b border-rose-100 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700"
        >
          {error}
        </p>
      ) : null}

      {overdueCount > 0 ? (
        <p className="flex items-center gap-2 border-b border-rose-100 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          {overdueCount === 1
            ? '1 boat is overdue back at the dock.'
            : `${overdueCount} boats are overdue back at the dock.`}
        </p>
      ) : null}

      <ul role="list" className="divide-y divide-slate-100">
        {/* Departed-and-quiet rows fold to one line so the list opens on who's next. */}
        {earlier.length > 0 ? (
          <li>
            <button
              type="button"
              onClick={() => setShowEarlier((v) => !v)}
              aria-expanded={showEarlier}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-slate-500 hover:bg-slate-50"
            >
              <ChevronRight
                className={cn('h-3.5 w-3.5 transition-transform', showEarlier && 'rotate-90')}
                aria-hidden
              />
              Earlier today ({earlier.length})
            </button>
            {showEarlier ? (
              <ul role="list" className="divide-y divide-slate-100 border-t border-slate-100">
                {earlier.map((it) => (
                  <BookingRow key={it.orderItemId} it={it} {...rowProps} />
                ))}
              </ul>
            ) : null}
          </li>
        ) : null}

        {upNext.map((it) => (
          <BookingRow key={it.orderItemId} it={it} {...rowProps} />
        ))}

        {upNext.length === 0 && earlier.length === 0 ? (
          <li className="px-3 py-6 text-center text-sm text-slate-500">
            {filtered ? 'No bookings match this filter.' : 'No bookings for this day yet.'}
          </li>
        ) : null}

        {/* Cancelled stays out of the way but never out of reach. */}
        {!filtered && cancelled.length > 0 ? (
          <li>
            <button
              type="button"
              onClick={() => setShowCancelled((v) => !v)}
              aria-expanded={showCancelled}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-slate-500 hover:bg-slate-50"
            >
              <ChevronRight
                className={cn('h-3.5 w-3.5 transition-transform', showCancelled && 'rotate-90')}
                aria-hidden
              />
              Cancelled ({cancelled.length})
            </button>
            {showCancelled ? (
              <ul role="list" className="divide-y divide-slate-100 border-t border-slate-100">
                {cancelled.map((it) => (
                  <BookingRow key={it.orderItemId} it={it} {...rowProps} />
                ))}
              </ul>
            ) : null}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * One party, one 40px row. The click surface toggles the detail drawer; inner
 * controls stop propagation so a tap on "Check in" never also opens the drawer.
 */
function BookingRow({
  it,
  isPending,
  signLinkBase,
  expanded,
  toggleExpanded,
  menuFor,
  setMenuFor,
  overdueBy,
  run,
}: {
  it: ManifestListItem;
  isPending: boolean;
  signLinkBase: string;
  expanded: Set<string>;
  toggleExpanded: (id: string) => void;
  menuFor: string | null;
  setMenuFor: (id: string | null) => void;
  overdueBy: (it: ManifestListItem) => number | null;
  run: (
    id: string,
    success: string,
    action: () => Promise<{ ok: boolean; error?: string; message?: string }>,
  ) => void;
}) {
  const isOpen = expanded.has(it.orderItemId);
  const late = overdueBy(it);
  const cancelled = it.status === 'CANCELLED';

  return (
    <li>
      <div
        onClick={(e) => {
          // Convenience click surface only — the chevron button is the accessible
          // control. Ignore clicks that land on real controls.
          const el = e.target as HTMLElement;
          if (el.closest('button, a, input, select, label')) return;
          toggleExpanded(it.orderItemId);
        }}
        className="grid min-h-10 cursor-pointer grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5 hover:bg-slate-50 md:grid-cols-[4.5rem_minmax(0,1.4fr)_minmax(0,1.1fr)_6.5rem_5.5rem_8rem_3.75rem]"
      >
        {/* Time */}
        <span
          className={cn(
            'whitespace-nowrap text-[13px] font-medium tabular-nums',
            cancelled ? 'text-slate-500' : 'text-slate-900',
          )}
        >
          {timeLabel(it.startMin)}
        </span>

        {/* Party */}
        <span className="min-w-0">
          <span className="flex items-baseline gap-1.5">
            <span
              className={cn(
                'truncate text-sm font-medium',
                cancelled ? 'text-slate-500 line-through' : 'text-slate-900',
              )}
            >
              {it.customerName}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-slate-500">· {it.quantity}</span>
          </span>
          {/* Narrow screens: boat + chips fold under the name. */}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 md:hidden">
            <BoatName it={it} />
            <WaiverCell it={it} />
            <BalanceCell it={it} />
          </span>
        </span>

        {/* Boat / activity */}
        <span className="hidden min-w-0 md:block">
          <BoatName it={it} />
        </span>

        {/* Waiver */}
        <span className="hidden md:block">
          <WaiverCell it={it} />
        </span>

        {/* Balance */}
        <span className="hidden text-right md:block">
          <BalanceCell it={it} />
        </span>

        {/* Status / one-tap check-in */}
        <span className="flex justify-end md:justify-start">
          {cancelled ? (
            <Chip className="bg-rose-50 text-rose-700">Cancelled</Chip>
          ) : late !== null ? (
            <Chip className="bg-rose-50 font-semibold text-rose-700">
              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
              {lateLabel(late)} overdue
            </Chip>
          ) : it.status === 'UPCOMING' ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() =>
                run(it.orderItemId, `Checked in ${bookingLabel(it)}.`, () =>
                  checkInOrderItem(it.orderItemId),
                )
              }
              aria-label={`Check in ${bookingLabel(it)}`}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-700 px-2.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" aria-hidden /> Check in
            </button>
          ) : it.status === 'CHECKED_IN' ? (
            <Chip className="bg-emerald-50 text-emerald-700">
              <Check className="h-3 w-3 shrink-0" aria-hidden /> Checked in
            </Chip>
          ) : it.status === 'NO_SHOW' ? (
            <Chip className="bg-slate-100 text-slate-600">No-show</Chip>
          ) : (
            <Chip className="bg-slate-100 text-slate-600">Completed</Chip>
          )}
        </span>

        {/* Overflow + expand */}
        <span className="col-start-3 row-start-1 flex items-center justify-end gap-0.5 md:col-start-auto md:row-start-auto">
          <RowMenu
            it={it}
            isPending={isPending}
            open={menuFor === it.orderItemId}
            setMenuFor={setMenuFor}
            run={run}
          />
          <button
            type="button"
            onClick={() => toggleExpanded(it.orderItemId)}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Hide' : 'Show'} details for ${bookingLabel(it)}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <ChevronDown
              className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-180')}
              aria-hidden
            />
          </button>
        </span>
      </div>

      {isOpen ? <RowDetail it={it} isPending={isPending} signLinkBase={signLinkBase} run={run} /> : null}
    </li>
  );
}

/** Small colour-key + boat name — identity, not status, so it stays grey text. */
function BoatName({ it }: { it: ManifestListItem }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-slate-600">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: it.color }}
        aria-hidden
      />
      <span className="truncate">{it.activityName}</span>
    </span>
  );
}

function WaiverCell({ it }: { it: ManifestListItem }) {
  if (it.status === 'CANCELLED') return <span className="text-xs text-slate-500">—</span>;
  return it.waiverSigned ? (
    <span className="inline-flex items-center gap-1 text-xs text-slate-500">
      <Check className="h-3 w-3 shrink-0" aria-hidden /> Waiver
    </span>
  ) : (
    <Chip className="bg-amber-50 text-amber-800">Waiver needed</Chip>
  );
}

function BalanceCell({ it }: { it: ManifestListItem }) {
  if (it.status === 'CANCELLED') return <span className="text-xs text-slate-500">—</span>;
  return it.balanceDueCents > 0 ? (
    <Chip className="bg-rose-50 font-semibold tabular-nums text-rose-700">
      {formatUSD(it.balanceDueCents)} due
    </Chip>
  ) : (
    <span className="text-xs text-slate-500">Paid</span>
  );
}

function Chip({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Per-row overflow: no-show / undo (demoted from always-visible buttons) plus the
 * order deep link. Carries `data-booking-action` so focus returns here after a write
 * replaces whatever control was pressed. (2.4.3)
 */
function RowMenu({
  it,
  isPending,
  open,
  setMenuFor,
  run,
}: {
  it: ManifestListItem;
  isPending: boolean;
  open: boolean;
  setMenuFor: (id: string | null) => void;
  run: (
    id: string,
    success: string,
    action: () => Promise<{ ok: boolean; error?: string; message?: string }>,
  ) => void;
}) {
  const itemClass =
    'flex w-full items-center px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50';

  return (
    <span className="relative" data-row-menu>
      <button
        type="button"
        data-booking-action={it.orderItemId}
        onClick={() => setMenuFor(open ? null : it.orderItemId)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${bookingLabel(it)}`}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>
      {open ? (
        <span
          role="menu"
          aria-label={`Actions for ${it.customerName}`}
          className="absolute right-0 top-full z-20 mt-1 block w-44 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg"
        >
          {it.status === 'UPCOMING' ? (
            <button
              type="button"
              role="menuitem"
              disabled={isPending}
              onClick={() =>
                run(it.orderItemId, `Marked ${bookingLabel(it)} as a no-show.`, () =>
                  markNoShowOrderItem(it.orderItemId),
                )
              }
              className={itemClass}
            >
              Mark no-show
            </button>
          ) : it.status === 'CHECKED_IN' ? (
            <button
              type="button"
              role="menuitem"
              disabled={isPending}
              onClick={() =>
                run(it.orderItemId, `Check-in undone for ${bookingLabel(it)}.`, () =>
                  undoCheckInOrderItem(it.orderItemId),
                )
              }
              className={itemClass}
            >
              Undo check-in
            </button>
          ) : it.status === 'NO_SHOW' ? (
            <button
              type="button"
              role="menuitem"
              disabled={isPending}
              onClick={() =>
                run(it.orderItemId, `No-show undone for ${bookingLabel(it)}.`, () =>
                  undoNoShowOrderItem(it.orderItemId),
                )
              }
              className={itemClass}
            >
              Undo no-show
            </button>
          ) : null}
          <Link
            href={`/orders/${it.orderId}`}
            role="menuitem"
            onClick={() => setMenuFor(null)}
            className={itemClass}
          >
            View order
          </Link>
        </span>
      ) : null}
    </span>
  );
}

/**
 * The drawer under a row: everything the row used to carry inline. Return time,
 * rate, order number + deep link, phone, sign-link distribution (copy/QR) and the
 * settle-balance / add-charge controls — each still ≤2 clicks from the list.
 */
function RowDetail({
  it,
  isPending,
  signLinkBase,
  run,
}: {
  it: ManifestListItem;
  isPending: boolean;
  signLinkBase: string;
  run: (
    id: string,
    success: string,
    action: () => Promise<{ ok: boolean; error?: string; message?: string }>,
  ) => void;
}) {
  return (
    <div className="border-t border-slate-100 bg-slate-50/60 px-3 py-2.5 md:pl-[6rem]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-600">
        <span>
          Back by{' '}
          <span className="font-medium tabular-nums text-slate-700">{returnLabel(it)}</span>
        </span>
        <span>{it.rateName}</span>
        <Link
          href={`/orders/${it.orderId}`}
          className="font-mono text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
        >
          {it.orderNumber}
        </Link>
        {it.customerPhone ? (
          <a
            href={`tel:${it.customerPhone}`}
            aria-label={`Call ${it.customerName} on ${it.customerPhone}`}
            className="inline-flex items-center gap-1 hover:text-slate-900"
          >
            <Phone className="h-3 w-3" aria-hidden /> {it.customerPhone}
          </a>
        ) : null}
        {!it.waiverSigned && it.status !== 'CANCELLED' ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-slate-600">Waiver:</span>
            <SignLinkActions
              signUrl={`${signLinkBase}/waiver/${it.orderItemId}`}
              label={`${it.customerName}, ${it.activityName}`}
              compact
            />
          </span>
        ) : null}
      </div>

      {it.status !== 'CANCELLED' ? (
        <BookingCharge
          orderId={it.orderId}
          balanceDueCents={it.balanceDueCents}
          run={run}
          isPending={isPending}
        />
      ) : null}
    </div>
  );
}
