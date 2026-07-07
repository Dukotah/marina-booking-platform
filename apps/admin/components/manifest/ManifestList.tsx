'use client';

import { useMemo, useState, useTransition } from 'react';
import { Check, X, UserX, RotateCcw, Phone } from 'lucide-react';
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
 * Dense operational manifest — the "run the dock from one screen" list that beats
 * Singenuity's text wall and matches FareHarbor's density. Every booking for the day
 * in time order, across activities, with waiver + outstanding balance visible and
 * one-tap check-in / no-show (and undo). Complements the visual Gantt.
 */
export function ManifestList({ rows }: { rows: ManifestRow[] }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) setError(res.error ?? 'Could not update the booking.');
    });
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
        No bookings for this day yet.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {error ? (
        <p className="border-b border-rose-100 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-600">
          {error}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2.5">Time</th>
              <th className="px-3 py-2.5">Activity</th>
              <th className="px-3 py-2.5">Guest</th>
              <th className="px-3 py-2.5 text-center">Party</th>
              <th className="px-3 py-2.5 text-center">Waiver</th>
              <th className="px-3 py-2.5 text-right">Balance</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5 text-right">Check-in</th>
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
                      ? 'bg-slate-50 text-slate-400'
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
                  <span className="mt-0.5 block text-xs text-slate-400">{it.rateName}</span>
                </td>
                <td className="px-3 py-2.5">
                  <div className="font-medium text-slate-800">{it.customerName}</div>
                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    <span className="font-mono">{it.orderNumber}</span>
                    {it.customerPhone ? (
                      <a href={`tel:${it.customerPhone}`} className="inline-flex items-center gap-1 hover:text-slate-600">
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
                    <span className="font-semibold text-rose-600">{formatUSD(it.balanceDueCents)}</span>
                  ) : (
                    <span className="text-slate-400">Paid</span>
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
                          onClick={() => run(() => checkInOrderItem(it.orderItemId))}
                          className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden /> Check in
                        </button>
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => run(() => markNoShowOrderItem(it.orderItemId))}
                          aria-label="Mark no-show"
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50"
                        >
                          <UserX className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </>
                    ) : it.status === 'CHECKED_IN' ? (
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => run(() => undoCheckInOrderItem(it.orderItemId))}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50"
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Undo
                      </button>
                    ) : it.status === 'NO_SHOW' ? (
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => run(() => undoNoShowOrderItem(it.orderItemId))}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50"
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Undo
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
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
  const map: Record<string, { label: string; cls: string }> = {
    UPCOMING: { label: 'Upcoming', cls: 'bg-sky-50 text-sky-700' },
    CHECKED_IN: { label: 'Checked in', cls: 'bg-emerald-50 text-emerald-700' },
    NO_SHOW: { label: 'No-show', cls: 'bg-slate-100 text-slate-500' },
    CANCELLED: { label: 'Cancelled', cls: 'bg-rose-50 text-rose-600' },
    COMPLETED: { label: 'Completed', cls: 'bg-slate-100 text-slate-600' },
  };
  const s = map[status] ?? { label: status, cls: 'bg-slate-100 text-slate-600' };
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>{s.label}</span>;
}
