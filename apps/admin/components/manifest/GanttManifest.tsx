'use client';

import { Sailboat } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { ManifestRow, ManifestSlot } from './types';
import { readableTextColor } from './types';
import { assignLanesGeneric } from './lanes';
import { BookingBlock, LANE_HEIGHT, LANE_GAP } from './BookingBlock';
import { OpenSlotBlock } from './OpenSlotBlock';
import { RentalBand } from './RentalBand';
import { ClosedRegion } from './ClosedRegion';
import { CapacityBar } from './CapacityBar';
import { deriveWindow, hourTicks, type DayWindow } from './time';
import { useNowMinute } from './useNowMinute';

/**
 * The Gantt-style day manifest / availability board: rows are activities (one
 * boat each), the X axis is time, and every row shows at a glance what a dock
 * dispatcher needs — BOOKED trips (solid color blocks), OPEN departures still for
 * sale (dashed teal blocks, click to start a booking), and CLOSED / out-of-service
 * windows (slate hatched). This is THE differentiator versus Singenuity's text
 * wall: staff see the whole day's availability and sell or check in with one tap.
 *
 * Layout: a sticky left label column (boat name + capacity) and a flexible,
 * horizontally-scrollable time track. Both share one hour grid so blocks line up
 * under the axis ticks, and a live "now" line tracks the current minute on today.
 */
export interface GanttManifestProps {
  rows: ManifestRow[];
  /** The day on screen, YYYY-MM-DD — passed to open-slot links + used for "now". */
  isoDate: string;
  /** Operator IANA timezone; the "now" line is measured against this clock. */
  timeZone: string;
}

const LABEL_WIDTH = 'w-56';

/** An open slot that still has room is sellable; full/empty-capacity slots aren't. */
function isSellable(slot: ManifestSlot): boolean {
  return slot.capacityTotal > 0 && slot.capacityBooked < slot.capacityTotal;
}

export function GanttManifest({ rows, isoDate, timeZone }: GanttManifestProps) {
  const now = useNowMinute(timeZone);
  const showNow = now !== null && now.isoDate === isoDate;

  // Derive one window across ALL rows (bookings AND open slots) so every row shares
  // an identical axis and nothing — including an early/late open departure — clips.
  const allIntervals = rows.flatMap((r) => [
    ...r.bookings.map((b) => ({ startMin: b.startMin, endMin: b.endMin })),
    ...r.slots.filter(isSellable).map((s) => ({ startMin: s.startMin, endMin: s.endMin })),
    // Rental availability bands share the axis so an 8a–8p window never clips.
    ...r.rentableBands.map((band) => ({ startMin: band.open, endMin: band.close })),
  ]);
  const win = deriveWindow(allIntervals);
  const ticks = hourTicks(win);
  const winStart = win.startHour * 60;
  const winTotal = Math.max(1, (win.endHour - win.startHour) * 60);
  const nowLeftPct = showNow ? ((now!.minutes - winStart) / winTotal) * 100 : null;
  const nowInView = nowLeftPct !== null && nowLeftPct >= 0 && nowLeftPct <= 100;

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-surface p-12 text-center">
        <Sailboat className="mx-auto h-10 w-10 text-ink-muted" aria-hidden />
        <h3 className="mt-3 text-sm font-semibold text-ink">No activities scheduled</h3>
        <p className="mt-1 text-sm text-ink-body">
          There are no activities with timeslots for this day. Pick another date or add timeslots
          from Activities.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Legend above the board so it's always visible (the board itself is tall). */}
      <Legend />
      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      {/* The board scrolls horizontally on its own; min-w keeps the axis legible on
          a phone without the whole page sliding. */}
      <div className="overflow-x-auto">
        <div className="min-w-[46rem]">
          {/* Axis header */}
          <div className="flex border-b border-line bg-surface-muted">
            <div
              className={cn(
                'sticky left-0 z-20 shrink-0 border-r border-line bg-surface-muted px-4 py-2 text-xs font-semibold text-ink-body',
                LABEL_WIDTH,
              )}
            >
              Boat
            </div>
            <div className="relative h-8 flex-1">
              {ticks.map((t) => (
                <div
                  key={t.hour}
                  className="absolute top-0 flex h-full -translate-x-1/2 items-center text-[11px] font-medium text-ink-body"
                  style={{ left: `${t.leftPct}%` }}
                >
                  {t.label}
                </div>
              ))}
            </div>
          </div>

          {/* Rows */}
          <div>
            {rows.map((row, index) => (
              <ManifestRowView
                key={row.activityId}
                row={row}
                win={win}
                ticks={ticks}
                isoDate={isoDate}
                zebra={index % 2 === 1}
                nowLeftPct={nowInView ? nowLeftPct : null}
              />
            ))}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

function ManifestRowView({
  row,
  win,
  ticks,
  isoDate,
  zebra,
  nowLeftPct,
}: {
  row: ManifestRow;
  win: DayWindow;
  ticks: ReturnType<typeof hourTicks>;
  isoDate: string;
  zebra: boolean;
  nowLeftPct: number | null;
}) {
  const fg = readableTextColor(row.color);
  const closed = row.closures.length > 0;
  // A rental boat sells a continuous window, not discrete departures; its band is
  // the availability. Shown only when open (data.ts already drops it on a closure).
  const bands = closed ? [] : row.rentableBands;
  const isRental = bands.length > 0;

  // Open departures still for sale on this boat (full/past-capacity slots drop out).
  // A rental boat already shows one continuous "available to rent" band, so its
  // discrete "+N" open slots are redundant noise — suppress them and let the band
  // read clean. Fixed-departure boats (no rentable band) keep their "+N" slots.
  const openSlots = isRental ? [] : row.slots.filter(isSellable);

  // Lane-pack bookings and open slots in one shared grid so a booking never sits on
  // top of the open block for its own slot. Bookings first keeps their lanes stable.
  const laneItems = [
    ...row.bookings.map((b) => ({ kind: 'booking' as const, startMin: b.startMin, endMin: b.endMin, booking: b })),
    ...openSlots.map((s) => ({ kind: 'open' as const, startMin: s.startMin, endMin: s.endMin, slot: s })),
  ];
  const { lanes, laneCount } = assignLanesGeneric(laneItems);
  // A rental boat with no booking today still needs a full lane of height so its
  // "available to rent" band has somewhere to draw; otherwise pack to the blocks.
  const effectiveLanes = laneItems.length === 0 && isRental ? 1 : laneCount;
  const trackHeight = effectiveLanes * LANE_HEIGHT + (effectiveLanes - 1) * LANE_GAP;

  return (
    <div className={cn('flex border-b border-line last:border-b-0', zebra && 'bg-surface-muted/40')}>
      {/* Sticky label cell — the boat name stays put while the day scrolls under it. */}
      <div
        className={cn(
          'sticky left-0 z-20 shrink-0 border-r border-line px-4 py-3',
          zebra ? 'bg-surface-muted/40' : 'bg-surface',
          LABEL_WIDTH,
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-bold"
            style={{ backgroundColor: row.color, color: fg }}
            aria-hidden
          >
            {row.activityName.slice(0, 2).toUpperCase()}
          </span>
          <span className="truncate text-sm font-semibold text-ink" title={row.activityName}>
            {row.activityName}
          </span>
        </div>
        <CapacityBar booked={row.capacityBooked} total={row.capacityTotal} />
      </div>

      {/* Time track */}
      <div className="relative flex-1 py-3 pr-3">
        {/* Hour gridlines */}
        <div className="pointer-events-none absolute inset-y-0 left-0 right-3">
          {ticks.map((t) => (
            <div
              key={t.hour}
              className="absolute inset-y-0 w-px bg-line"
              style={{ left: `${t.leftPct}%` }}
            />
          ))}
        </div>

        {/* Live "now" line on today, drawn behind the blocks. */}
        {nowLeftPct !== null ? (
          <div
            className="pointer-events-none absolute inset-y-0 z-0 w-px bg-accent"
            style={{ left: `${nowLeftPct}%` }}
            aria-hidden
          />
        ) : null}

        {/* Blocks */}
        <div className="relative" style={{ height: trackHeight }}>
          {/* Rental availability wash, behind everything (non-interactive). */}
          <RentalBand bands={bands} window={win} />

          {laneItems.length === 0 ? (
            <div className="relative z-10 flex h-full items-center px-2 text-xs text-ink-body">
              {closed ? ' ' : isRental ? 'Available to rent' : 'No departures'}
            </div>
          ) : (
            laneItems.map((item, i) =>
              item.kind === 'booking' ? (
                <BookingBlock
                  key={`b-${item.booking.orderItemId}`}
                  booking={item.booking}
                  color={row.color}
                  window={win}
                  lane={lanes[i]}
                />
              ) : (
                <OpenSlotBlock
                  key={`o-${item.slot.timeslotId}`}
                  slot={item.slot}
                  activityId={row.activityId}
                  activityName={row.activityName}
                  isoDate={isoDate}
                  window={win}
                  lane={lanes[i]}
                  laneHeight={LANE_HEIGHT}
                  laneGap={LANE_GAP}
                />
              ),
            )
          )}

          {/* Full-day closed / out-of-service shade, over the whole track. */}
          {closed ? <ClosedRegion closures={row.closures} /> : null}
        </div>
      </div>
    </div>
  );
}

/** Board key: what the three block styles mean. */
function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-4 border-t border-line bg-surface-muted px-4 py-2.5 text-xs text-ink-body">
      <span className="font-medium text-ink">Timeline:</span>
      <span className="inline-flex items-center gap-1.5">
        {/* Booked blocks carry each boat's own white-label color; the swatch is a
            neutral solid standing in for "a filled block", not a literal hue. */}
        <span className="h-3 w-5 rounded-sm bg-slate-500" aria-hidden />
        Booked
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="h-3 w-5 rounded-sm border border-dashed border-accent/60 bg-accent-tint"
          aria-hidden
        />
        Available — tap to book
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="h-3 w-5 rounded-sm border border-dashed border-accent/40 bg-accent-tint"
          aria-hidden
        />
        Available to rent
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="h-3 w-5 rounded-sm border border-slate-300"
          style={{
            backgroundImage:
              'repeating-linear-gradient(135deg, rgb(148 163 184 / 0.5) 0, rgb(148 163 184 / 0.5) 3px, rgb(241 245 249) 3px, rgb(241 245 249) 6px)',
          }}
          aria-hidden
        />
        Closed
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-px bg-accent" aria-hidden />
        Now
      </span>
    </div>
  );
}
