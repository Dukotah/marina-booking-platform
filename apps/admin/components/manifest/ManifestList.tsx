'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { AlertTriangle, Check, UserX, RotateCcw, Phone } from 'lucide-react';
import { formatUSD } from '../../lib/format';
import { localMinutesOfDay, todayIsoIn } from './tz';
import { SignLinkActions } from '../waiver/SignLinkActions';
import type { ManifestRow, ManifestListItem } from './types';
import {
  checkInOrderItem,
  undoCheckInOrderItem,
  markNoShowOrderItem,
  undoNoShowOrderItem,
} from '../../app/manifest/actions';

/** "8:00 AM" from minutes-since-midnight (already operator-local). */
function timeLabel(startMin: number): string {
  const h24 = Math.floor(startMin / 60);
  const m = startMin % 60;
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/**
 * "2:00 PM", or "8:00 AM (next day)" for a rate that runs past midnight (e.g. a 24h
 * overnight rental). `returnMin` is the honest wall-clock return; `endsNextDay` says
 * whether it lands on tomorrow — the old code clamped to midnight and printed a
 * misleading "12:00 AM" for every overnight trip.
 */
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
 * How a control in this table names the booking it acts on.
 *
 * Every row renders the same two or three controls, so an accessible name of
 * "Check in" is thirty identical controls to anyone not reading the row visually —
 * and the one thing that matters at the dock is *which* booking is being checked in.
 * Guest, activity, and now both ends of the trip: when a boat is due back is the
 * number staff are actually working from, so it belongs in the name too. (4.1.2, 2.4.6)
 */
function bookingLabel(it: ManifestListItem): string {
  return `${it.customerName}, ${it.activityName} at ${timeLabel(it.startMin)}, back by ${returnLabel(
    it,
  )}`;
}

/**
 * Dense operational manifest — the "run the dock from one screen" list that beats
 * Singenuity's text wall and matches FareHarbor's density. Every booking for the day
 * in time order, across activities, with waiver + outstanding balance visible and
 * one-tap check-in / no-show (and undo). Complements the visual Gantt.
 */
export function ManifestList({
  rows,
  timeZone,
  isoDate,
  signLinkBase,
}: {
  rows: ManifestRow[];
  /** Operator IANA timezone — the lens "now" is measured through. */
  timeZone: string;
  /** The day being shown, YYYY-MM-DD. Overdue only means anything on today. */
  isoDate: string;
  /** Customer web base URL — unsigned rows get copy-link + QR so staff can hand
   *  the guest the standalone signer instead of paper. */
  signLinkBase: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [focusAfterId, setFocusAfterId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const tableRef = useRef<HTMLDivElement>(null);

  /**
   * Operator-local "now", set after mount and re-read every minute.
   *
   * Deliberately null on the first render rather than computed inline: the server
   * render and the hydration render would disagree about the clock, and React would
   * either warn or silently keep the server's stale minute. Starting from null means
   * the first paint simply has no overdue state and the client fills it in — and the
   * interval is what makes a boat that goes overdue at 2:01 say so at 2:01, instead of
   * whenever somebody happens to reload.
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

  /**
   * Minutes a boat is late, or null when it is not.
   *
   * "Overdue" is a checked-in trip whose return time has passed — the guest is out on
   * the water and should be back. An UPCOMING trip past its end time is a different
   * problem (a no-show), and the row already says so.
   */
  function overdueBy(it: ManifestListItem): number | null {
    if (!now || now.isoDate !== isoDate) return null;
    if (it.status !== 'CHECKED_IN') return null;
    const late = now.minutes - it.endMin;
    return late > 0 ? late : null;
  }

  const overdueCount = items.filter((it) => overdueBy(it) !== null).length;

  /**
   * Run a check-in/no-show write, then say what happened and put the keyboard back
   * somewhere real.
   *
   * A successful write swaps the button that was just pressed for a different one
   * ("Check in" becomes "Undo"), which destroys the focused element and drops focus
   * to <body> — a keyboard user is silently returned to the top of a thirty-row
   * table. `focusAfterId` moves focus onto the control that replaced it, and the
   * polite live region says which booking changed. (2.4.3, 4.1.3)
   */
  function run(
    orderItemId: string,
    success: string,
    action: () => Promise<{ ok: boolean; error?: string }>,
  ) {
    setError(null);
    setAnnouncement('');
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setError(res.error ?? 'Could not update the booking.');
        return;
      }
      setAnnouncement(success);
      setFocusAfterId(orderItemId);
    });
  }

  useEffect(() => {
    // Wait for the transition to commit the re-rendered row before reaching for the
    // replacement control — during `isPending` the old button is still mounted.
    if (!focusAfterId || isPending) return;
    const next = tableRef.current?.querySelector<HTMLButtonElement>(
      `[data-booking-action="${focusAfterId}"]`,
    );
    next?.focus();
    setFocusAfterId(null);
  }, [focusAfterId, isPending]);

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
        No bookings for this day yet.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Present from first render so an insertion into it is actually announced; a
          live region created at the same moment as its content usually is not. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {/* role="alert" — a failed write is async with no focus move, so nothing else
          would tell a screen-reader user the tap did not take. rose-700, not
          rose-600: rose-600 on rose-50 measures 4.30:1. (4.1.3, 1.4.3) */}
      {error ? (
        <p
          role="alert"
          className="border-b border-rose-100 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700"
        >
          {error}
        </p>
      ) : null}

      {/* The headline number at a dock: how many boats are out past their return time.
          Words and an icon, never the colour on its own. (1.4.1) */}
      {overdueCount > 0 ? (
        <p className="flex items-center gap-2 border-b border-rose-100 bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-800">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          {overdueCount === 1
            ? '1 boat is overdue back at the dock.'
            : `${overdueCount} boats are overdue back at the dock.`}
        </p>
      ) : null}

      <div className="overflow-x-auto" ref={tableRef}>
        <table className="w-full border-collapse text-sm">
          {/* The table sits under the view toggle with no heading of its own, so a
              reader jumping table-to-table lands in an unnamed grid. (1.3.1) */}
          <caption className="sr-only">
            Bookings for the selected day, in start-time order, with the time each boat is
            due back.
          </caption>
          <thead>
            {/*
              Five of the eight columns are `hidden sm:table-cell`, and what they carry
              is re-stated inside the Guest cell under `sm:hidden`. That is what keeps a
              360px phone from scrolling sideways without dropping a single fact: the
              browser removes display:none content from the accessibility tree, so at
              any one width exactly one copy exists — a screen reader never hears the
              activity twice, and a narrow screen never hides the balance.
            */}
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              {/* scope="col" binds every cell below to its header, which is what
                  makes a dense grid readable a cell at a time. (1.3.1) */}
              <th scope="col" className="px-3 py-2.5">
                Out · back
              </th>
              <th scope="col" className="hidden px-3 py-2.5 sm:table-cell">
                Activity
              </th>
              <th scope="col" className="px-3 py-2.5">
                Guest
              </th>
              <th scope="col" className="hidden px-3 py-2.5 text-center sm:table-cell">
                Party
              </th>
              <th scope="col" className="hidden px-3 py-2.5 text-center sm:table-cell">
                Waiver
              </th>
              <th scope="col" className="hidden px-3 py-2.5 text-right sm:table-cell">
                Balance
              </th>
              <th scope="col" className="hidden px-3 py-2.5 sm:table-cell">
                Status
              </th>
              <th scope="col" className="px-3 py-2.5 text-right">
                Check-in
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((it) => {
              const late = overdueBy(it);
              return (
              <tr
                key={it.orderItemId}
                className={
                  late !== null
                    ? // An overdue boat outranks the checked-in tint: it is the row
                      // staff need to find first. The words in the cell carry the
                      // meaning; this is only what makes it findable. (1.4.1)
                      'bg-rose-50/60'
                    : it.status === 'CHECKED_IN'
                      ? 'bg-emerald-50/40'
                      : it.status === 'NO_SHOW'
                        ? // slate-500, not slate-400: slate-400 on the slate-50 row
                          // fill is 2.4:1. The row tint is decoration either way — the
                          // status is stated in the Status cell. (1.4.3, 1.4.1)
                          'bg-slate-50 text-slate-500'
                        : ''
                }
              >
                {/*
                  Both ends of the trip, because only one of them was ever on screen.
                  A dock does not ask "when did that boat leave" — it asks when it is
                  coming back, and until now the answer was in the Gantt or in nobody's
                  head. `endMin` was already computed from the rate duration.
                */}
                <td className="px-3 py-2.5 align-top">
                  <div className="whitespace-nowrap font-semibold tabular-nums text-slate-800">
                    {timeLabel(it.startMin)}
                  </div>
                  <div className="whitespace-nowrap text-xs text-slate-600">
                    back by{' '}
                    <span className="font-semibold tabular-nums text-slate-700">
                      {returnLabel(it)}
                    </span>
                  </div>
                  {late !== null ? (
                    <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-900">
                      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                      {lateLabel(late)} overdue
                    </span>
                  ) : null}
                </td>
                <td className="hidden px-3 py-2.5 align-top sm:table-cell">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: it.color }} aria-hidden />
                    <span className="truncate text-slate-700">{it.activityName}</span>
                  </span>
                  {/* slate-500 throughout: slate-400 on white is 2.45:1, well under
                      the 4.5:1 floor, and it was the single biggest source of failing
                      nodes on this screen. (1.4.3) */}
                  <span className="mt-0.5 block text-xs text-slate-500">{it.rateName}</span>
                </td>
                <td className="px-3 py-2.5 align-top">
                  <div className="font-medium text-slate-800">{it.customerName}</div>
                  {/* slate-600, not slate-500: slate-500 measures 4.66:1 on white and
                      slips under the floor on a tinted row — and this row now carries
                      a rose tint when the boat is overdue. slate-600 clears on every
                      fill this table uses. (1.4.3) */}
                  <div className="flex flex-wrap items-center gap-x-3 text-xs text-slate-600">
                    <span className="font-mono">{it.orderNumber}</span>
                    {it.customerPhone ? (
                      <a
                        href={`tel:${it.customerPhone}`}
                        aria-label={`Call ${it.customerName} on ${it.customerPhone}`}
                        className="inline-flex items-center gap-1 py-1.5 hover:text-slate-700"
                      >
                        <Phone className="h-3 w-3" aria-hidden /> {it.customerPhone}
                      </a>
                    ) : null}
                  </div>

                  {/* Phone-width fold-in of the five columns hidden above. */}
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 sm:hidden">
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: it.color }}
                        aria-hidden
                      />
                      {it.activityName} · {it.rateName}
                    </span>
                    <StatusBadge status={it.status} />
                    <span className="text-xs text-slate-600">
                      Party of <span className="font-semibold tabular-nums">{it.quantity}</span>
                    </span>
                    {it.waiverSigned ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                        <Check className="h-3 w-3" aria-hidden /> Waiver signed
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                          Waiver needed
                        </span>
                        <SignLinkActions
                          signUrl={`${signLinkBase}/waiver/${it.orderItemId}`}
                          label={`${it.customerName}, ${it.activityName}`}
                          compact
                        />
                      </span>
                    )}
                    {it.balanceDueCents > 0 ? (
                      <span className="text-xs font-semibold tabular-nums text-rose-700">
                        {formatUSD(it.balanceDueCents)} due
                      </span>
                    ) : (
                      <span className="text-xs text-slate-600">Paid</span>
                    )}
                  </div>
                </td>
                <td className="hidden px-3 py-2.5 text-center align-top tabular-nums text-slate-700 sm:table-cell">
                  {it.quantity}
                </td>
                <td className="hidden px-3 py-2.5 text-center align-top sm:table-cell">
                  {it.waiverSigned ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                      <Check className="h-3 w-3" aria-hidden /> Signed
                    </span>
                  ) : (
                    <span className="inline-flex flex-col items-center gap-1">
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                        Needed
                      </span>
                      {/* Hand the guest the standalone signer: copy the link to
                          text it, or show a QR they scan at the counter. */}
                      <SignLinkActions
                        signUrl={`${signLinkBase}/waiver/${it.orderItemId}`}
                        label={`${it.customerName}, ${it.activityName}`}
                        compact
                      />
                    </span>
                  )}
                </td>
                <td className="hidden px-3 py-2.5 text-right align-top tabular-nums sm:table-cell">
                  {it.balanceDueCents > 0 ? (
                    // rose-700, not rose-600: rose-600 clears on white (4.70:1) but
                    // measures 4.49:1 on the slate-50 fill a no-show row carries —
                    // a hundredth under the floor, on the number that says money is
                    // still owed. rose-700 clears on both. (1.4.3)
                    <span className="font-semibold text-rose-700">{formatUSD(it.balanceDueCents)}</span>
                  ) : (
                    <span className="text-slate-500">Paid</span>
                  )}
                </td>
                <td className="hidden px-3 py-2.5 align-top sm:table-cell">
                  <StatusBadge status={it.status} />
                </td>
                <td className="px-3 py-2.5 align-top">
                  {/* Stacked and 44px tall on a phone, compact and inline from `sm`.
                      These are tapped with a thumb while holding a bow line. (2.5.5) */}
                  <div className="flex flex-col items-stretch gap-1 sm:flex-row sm:items-center sm:justify-end">
                    {it.status === 'UPCOMING' ? (
                      <>
                        <button
                          type="button"
                          disabled={isPending}
                          data-booking-action={it.orderItemId}
                          onClick={() =>
                            run(it.orderItemId, `Checked in ${bookingLabel(it)}.`, () =>
                              checkInOrderItem(it.orderItemId),
                            )
                          }
                          // The visible words lead the name, so speech control still
                          // matches what is on screen. (2.5.3)
                          aria-label={`Check in ${bookingLabel(it)}`}
                          // emerald-700, not emerald-600: white on emerald-600 is
                          // 3.79:1. emerald-700 is 5.5:1 and keeps the green. (1.4.3)
                          className="inline-flex min-h-11 items-center justify-center gap-1 rounded-md bg-emerald-700 px-2.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 sm:min-h-0 sm:py-1.5"
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden /> Check in
                        </button>
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() =>
                            run(it.orderItemId, `Marked ${bookingLabel(it)} as a no-show.`, () =>
                              markNoShowOrderItem(it.orderItemId),
                            )
                          }
                          aria-label={`Mark no-show: ${bookingLabel(it)}`}
                          className="inline-flex min-h-11 items-center justify-center gap-1 rounded-md border border-slate-300 px-2 text-xs font-medium text-slate-600 hover:bg-slate-50 sm:min-h-0 sm:py-1.5"
                        >
                          <UserX className="h-3.5 w-3.5" aria-hidden />
                          {/* The icon is the whole control from `sm` up, where the
                              column is narrow; on a phone it gets its word back so the
                              two stacked buttons are not a guess. The accessible name
                              contains it either way. (2.5.3) */}
                          <span className="sm:hidden">No-show</span>
                        </button>
                      </>
                    ) : it.status === 'CHECKED_IN' ? (
                      <button
                        type="button"
                        disabled={isPending}
                        data-booking-action={it.orderItemId}
                        onClick={() =>
                          run(it.orderItemId, `Check-in undone for ${bookingLabel(it)}.`, () =>
                            undoCheckInOrderItem(it.orderItemId),
                          )
                        }
                        aria-label={`Undo check-in for ${bookingLabel(it)}`}
                        className="inline-flex min-h-11 items-center justify-center gap-1 rounded-md border border-slate-300 px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 sm:min-h-0 sm:py-1.5"
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Undo
                      </button>
                    ) : it.status === 'NO_SHOW' ? (
                      <button
                        type="button"
                        disabled={isPending}
                        data-booking-action={it.orderItemId}
                        onClick={() =>
                          run(it.orderItemId, `No-show undone for ${bookingLabel(it)}.`, () =>
                            undoNoShowOrderItem(it.orderItemId),
                          )
                        }
                        aria-label={`Undo no-show for ${bookingLabel(it)}`}
                        className="inline-flex min-h-11 items-center justify-center gap-1 rounded-md border border-slate-300 px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 sm:min-h-0 sm:py-1.5"
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Undo
                      </button>
                    ) : (
                      <>
                        <span className="text-right text-xs text-slate-500" aria-hidden>
                          —
                        </span>
                        {/* An em dash is a typographic placeholder, not information;
                            spoken, it is either silence or "dash". (1.3.1) */}
                        <span className="sr-only">No check-in action available</span>
                      </>
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ManifestListItem['status'] }) {
  // Every entry carries a text label, so status never rides on the pill colour
  // alone. The greys are the readable pair on their own fill: slate-500 on
  // slate-100 is 4.34:1 and rose-600 on rose-50 is 4.30:1 — both under. (1.4.1, 1.4.3)
  const map: Record<string, { label: string; cls: string }> = {
    UPCOMING: { label: 'Upcoming', cls: 'bg-sky-50 text-sky-700' },
    CHECKED_IN: { label: 'Checked in', cls: 'bg-emerald-50 text-emerald-700' },
    NO_SHOW: { label: 'No-show', cls: 'bg-slate-100 text-slate-600' },
    CANCELLED: { label: 'Cancelled', cls: 'bg-rose-50 text-rose-700' },
    COMPLETED: { label: 'Completed', cls: 'bg-slate-100 text-slate-600' },
  };
  const s = map[status] ?? { label: status, cls: 'bg-slate-100 text-slate-600' };
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>{s.label}</span>;
}
