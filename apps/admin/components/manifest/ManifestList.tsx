'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Check, UserX, RotateCcw, Phone } from 'lucide-react';
import { formatUSD } from '../../lib/format';
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
 * How a control in this table names the booking it acts on.
 *
 * Every row renders the same two or three controls, so an accessible name of
 * "Check in" is thirty identical controls to anyone not reading the row visually —
 * and the one thing that matters at the dock is *which* booking is being checked in.
 * Guest, activity and start time are the three facts staff read off the row before
 * they tap, so they are the three facts the name carries. (4.1.2, 2.4.6)
 */
function bookingLabel(it: ManifestListItem): string {
  return `${it.customerName}, ${it.activityName} at ${timeLabel(it.startMin)}`;
}

/**
 * Dense operational manifest — the "run the dock from one screen" list that beats
 * Singenuity's text wall and matches FareHarbor's density. Every booking for the day
 * in time order, across activities, with waiver + outstanding balance visible and
 * one-tap check-in / no-show (and undo). Complements the visual Gantt.
 */
export function ManifestList({ rows }: { rows: ManifestRow[] }) {
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [focusAfterId, setFocusAfterId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const tableRef = useRef<HTMLDivElement>(null);

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
      <div className="overflow-x-auto" ref={tableRef}>
        <table className="w-full border-collapse text-sm">
          {/* The table sits under the view toggle with no heading of its own, so a
              reader jumping table-to-table lands in an unnamed grid. (1.3.1) */}
          <caption className="sr-only">
            Bookings for the selected day, in start-time order.
          </caption>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              {/* scope="col" binds every cell below to its header, which is what
                  makes a dense grid readable a cell at a time. (1.3.1) */}
              <th scope="col" className="px-3 py-2.5">
                Time
              </th>
              <th scope="col" className="px-3 py-2.5">
                Activity
              </th>
              <th scope="col" className="px-3 py-2.5">
                Guest
              </th>
              <th scope="col" className="px-3 py-2.5 text-center">
                Party
              </th>
              <th scope="col" className="px-3 py-2.5 text-center">
                Waiver
              </th>
              <th scope="col" className="px-3 py-2.5 text-right">
                Balance
              </th>
              <th scope="col" className="px-3 py-2.5">
                Status
              </th>
              <th scope="col" className="px-3 py-2.5 text-right">
                Check-in
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((it) => (
              <tr
                key={it.orderItemId}
                className={
                  it.status === 'CHECKED_IN'
                    ? 'bg-emerald-50/40'
                    : it.status === 'NO_SHOW'
                      ? // slate-500, not slate-400: slate-400 on the slate-50 row
                        // fill is 2.4:1. The row tint is decoration either way — the
                        // status is stated in the Status cell. (1.4.3, 1.4.1)
                        'bg-slate-50 text-slate-500'
                      : ''
                }
              >
                <td className="whitespace-nowrap px-3 py-2.5 font-medium tabular-nums text-slate-700">
                  {timeLabel(it.startMin)}
                </td>
                <td className="px-3 py-2.5">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: it.color }} aria-hidden />
                    <span className="truncate text-slate-700">{it.activityName}</span>
                  </span>
                  {/* slate-500 throughout: slate-400 on white is 2.45:1, well under
                      the 4.5:1 floor, and it was the single biggest source of failing
                      nodes on this screen. (1.4.3) */}
                  <span className="mt-0.5 block text-xs text-slate-500">{it.rateName}</span>
                </td>
                <td className="px-3 py-2.5">
                  <div className="font-medium text-slate-800">{it.customerName}</div>
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    <span className="font-mono">{it.orderNumber}</span>
                    {it.customerPhone ? (
                      <a
                        href={`tel:${it.customerPhone}`}
                        aria-label={`Call ${it.customerName} on ${it.customerPhone}`}
                        className="inline-flex items-center gap-1 hover:text-slate-700"
                      >
                        <Phone className="h-3 w-3" aria-hidden /> {it.customerPhone}
                      </a>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-center tabular-nums text-slate-700">{it.quantity}</td>
                <td className="px-3 py-2.5 text-center">
                  {it.waiverSigned ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                      <Check className="h-3 w-3" aria-hidden /> Signed
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                      Needed
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
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
                <td className="px-3 py-2.5">
                  <StatusBadge status={it.status} />
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center justify-end gap-1">
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
                          className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
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
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50"
                        >
                          <UserX className="h-3.5 w-3.5" aria-hidden />
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
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50"
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
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50"
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Undo
                      </button>
                    ) : (
                      <>
                        <span className="text-xs text-slate-500" aria-hidden>
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
            ))}
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
