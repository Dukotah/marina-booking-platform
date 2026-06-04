'use client';

import { useState, useTransition } from 'react';
import { Check, Clock, Loader2, RotateCcw, Users } from 'lucide-react';
import { cn } from '../../lib/cn';
import { formatTime } from '../../lib/format';
import { checkInOrderItem, undoCheckInOrderItem } from '../../app/manifest/actions';
import type { ManifestBooking } from './types';
import { readableTextColor } from './types';
import { statusStyle } from './status';
import { blockGeometry, type DayWindow } from './time';

/**
 * A single positioned booking on a Gantt row. The block is colored by the activity
 * color (white-label) and exposes a one-click check-in: tapping the action calls the
 * `checkInOrderItem` server action and optimistically reflects the new state. This is
 * the core interaction that replaces Singenuity's read-only text wall.
 */
export interface BookingBlockProps {
  booking: ManifestBooking;
  /** Activity color (hex) used as the block background. */
  color: string;
  window: DayWindow;
  /** Index in the row's lane assignment (for vertical stacking of overlaps). */
  lane: number;
}

/** px per stacked lane — shared with the row so heights line up. */
export const LANE_HEIGHT = 44;
/** vertical gap between stacked lanes. */
export const LANE_GAP = 6;

export function BookingBlock({ booking, color, window: win, lane }: BookingBlockProps) {
  const geo = blockGeometry(booking.startMin, booking.endMin, win);
  const [status, setStatus] = useState(booking.status);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!geo) return null;

  const style = statusStyle(status);
  const fg = readableTextColor(color);
  const checkedIn = status === 'CHECKED_IN';
  const canCheckIn = status === 'UPCOMING' || status === 'CHECKED_IN';

  const top = lane * (LANE_HEIGHT + LANE_GAP);
  const height = LANE_HEIGHT;

  function toggleCheckIn(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setError(null);
    const goingIn = status !== 'CHECKED_IN';
    // Optimistic update; revert on failure.
    setStatus(goingIn ? 'CHECKED_IN' : 'UPCOMING');
    startTransition(async () => {
      const res = goingIn
        ? await checkInOrderItem(booking.orderItemId)
        : await undoCheckInOrderItem(booking.orderItemId);
      if (!res.ok) {
        setStatus(goingIn ? 'UPCOMING' : 'CHECKED_IN');
        setError(res.error ?? 'Something went wrong');
      }
    });
  }

  return (
    <div
      className="group absolute"
      style={{
        left: `${geo.leftPct}%`,
        width: `${geo.widthPct}%`,
        top,
        height,
      }}
      title={`${booking.customerName} · ${booking.rateName} · ${formatTime(booking.startISO)}`}
    >
      <div
        className={cn(
          'flex h-full w-full items-center gap-2 overflow-hidden rounded-lg border px-2 text-xs shadow-sm transition-shadow',
          'border-black/10 hover:shadow-md',
          style.muted && 'opacity-60 saturate-50',
        )}
        style={{ backgroundColor: color, color: fg }}
      >
        {checkedIn ? (
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/25"
            aria-hidden
          >
            <Check className="h-3.5 w-3.5" />
          </span>
        ) : null}

        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate font-semibold">{booking.customerName}</div>
          <div className="flex items-center gap-2 truncate opacity-90">
            <span className="inline-flex items-center gap-0.5">
              <Clock className="h-3 w-3" aria-hidden />
              {formatTime(booking.startISO)}
            </span>
            <span className="inline-flex items-center gap-0.5">
              <Users className="h-3 w-3" aria-hidden />
              {booking.quantity}
            </span>
            <span className="truncate">{booking.rateName}</span>
          </div>
        </div>

        {canCheckIn ? (
          <button
            type="button"
            onClick={toggleCheckIn}
            disabled={isPending}
            aria-label={checkedIn ? 'Undo check-in' : 'Check in guest'}
            className={cn(
              'flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-semibold transition-colors',
              'bg-white/90 text-slate-900 hover:bg-white disabled:opacity-70',
            )}
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : checkedIn ? (
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Check className="h-3.5 w-3.5" aria-hidden />
            )}
            <span className="hidden sm:inline">{checkedIn ? 'Undo' : 'Check in'}</span>
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="absolute left-0 top-full z-10 mt-1 rounded-md bg-rose-600 px-2 py-1 text-[11px] text-white shadow">
          {error}
        </div>
      ) : null}
    </div>
  );
}
