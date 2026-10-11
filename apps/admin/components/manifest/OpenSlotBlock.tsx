import Link from 'next/link';
import { Plus } from 'lucide-react';
import { cn } from '../../lib/cn';
import { formatTime } from '../../lib/format';
import type { ManifestSlot } from './types';
import { blockGeometry, type DayWindow } from './time';

/**
 * A positioned OPEN (available) slot on a Gantt row — the FareHarbor "white space
 * you can sell" made clickable. Rendered only for slots that still have room, it
 * reads as actionable emptiness: a dashed, teal-tinted outline block (distinct from
 * the solid, filled booking blocks) labelled with the spots left.
 *
 * Clicking it opens the register (POS) for a new booking. POS always loads the
 * current day's catalog and does not yet accept a deep-linked slot, so the link
 * carries the activity + date as hints (`?activity=…&date=…&slot=…`); the limitation
 * is that staff still pick the exact departure in the register. See data.ts /
 * app/pos/page.tsx — wiring a true preselect is a deliberate follow-up.
 */
export interface OpenSlotBlockProps {
  slot: ManifestSlot;
  activityId: string;
  activityName: string;
  /** The day on screen (YYYY-MM-DD) — passed to the register as a hint. */
  isoDate: string;
  window: DayWindow;
  /** Vertical stacking index (open blocks share the booking lane system). */
  lane: number;
  /** px per lane + gap, shared with BookingBlock so rows line up. */
  laneHeight: number;
  laneGap: number;
}

export function OpenSlotBlock({
  slot,
  activityId,
  activityName,
  isoDate,
  window: win,
  lane,
  laneHeight,
  laneGap,
}: OpenSlotBlockProps) {
  const geo = blockGeometry(slot.startMin, slot.endMin, win);
  if (!geo) return null;

  const remaining = Math.max(0, slot.capacityTotal - slot.capacityBooked);
  const top = lane * (laneHeight + laneGap);
  const time = formatTime(slot.startISO);
  const spots = `${remaining} open`;

  return (
    <Link
      href={`/pos?activity=${encodeURIComponent(activityId)}&date=${encodeURIComponent(
        isoDate,
      )}&slot=${encodeURIComponent(slot.timeslotId)}`}
      className="group absolute block"
      style={{ left: `${geo.leftPct}%`, width: `${geo.widthPct}%`, top, height: laneHeight }}
      // A 44px-tall dashed lane that reads "tap to sell this departure".
      aria-label={`Open departure: ${activityName} at ${time}, ${remaining} ${
        remaining === 1 ? 'spot' : 'spots'
      } left — tap to start a booking`}
      title={`${activityName} · ${time} · ${spots}`}
    >
      <span
        className={cn(
          'flex h-full w-full items-center gap-1.5 overflow-hidden rounded-lg border border-dashed px-2 text-xs transition-colors',
          // Teal-tinted dashed outline = actionable empty, visually apart from the
          // solid activity-colored booking blocks. The ONE accent, used quietly.
          'border-accent/50 bg-accent-tint text-accent-ink',
          'hover:border-accent hover:bg-surface group-focus-visible:ring-2 group-focus-visible:ring-focus',
        )}
      >
        <Plus className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
        {/* Count only — the departure time is already read off the axis, and
            packing it in here clips the label on a one-hour-wide block. */}
        <span className="font-semibold tabular-nums leading-none">{remaining}</span>
      </span>
    </Link>
  );
}
