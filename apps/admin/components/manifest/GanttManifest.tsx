import { Sailboat } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { ManifestRow } from './types';
import { readableTextColor } from './types';
import { assignLanes } from './lanes';
import { BookingBlock, LANE_HEIGHT, LANE_GAP } from './BookingBlock';
import { CapacityBar } from './CapacityBar';
import { deriveWindow, hourTicks, type DayWindow } from './time';

/**
 * The Gantt-style day manifest: rows are activities, the X axis is time, and each
 * booking is a color-coded block positioned by its slot time. This is THE
 * differentiator versus Singenuity's text wall — staff see the whole day at a glance
 * and can check guests in with one tap.
 *
 * Layout: a fixed-width label column (activity name + capacity) and a flexible time
 * track. Both share the same hour grid so blocks line up under the axis ticks.
 */
export interface GanttManifestProps {
  rows: ManifestRow[];
}

const LABEL_WIDTH = 'w-56';

export function GanttManifest({ rows }: GanttManifestProps) {
  // Derive one window across ALL rows so every row shares an identical time axis.
  const allBookings = rows.flatMap((r) =>
    r.bookings.map((b) => ({ startMin: b.startMin, endMin: b.endMin })),
  );
  const win = deriveWindow(allBookings);
  const ticks = hourTicks(win);

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
        <Sailboat className="mx-auto h-10 w-10 text-slate-300" aria-hidden />
        <h3 className="mt-3 text-sm font-semibold text-slate-700">No activities scheduled</h3>
        <p className="mt-1 text-sm text-slate-500">
          There are no activities with timeslots for this day. Pick another date or add timeslots
          from Activities.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Axis header */}
      <div className="flex border-b border-slate-200 bg-slate-50">
        <div className={cn('shrink-0 px-4 py-2 text-xs font-semibold text-slate-500', LABEL_WIDTH)}>
          Activity
        </div>
        <div className="relative h-8 flex-1">
          {ticks.map((t) => (
            <div
              key={t.hour}
              className="absolute top-0 flex h-full -translate-x-1/2 items-center text-[11px] font-medium text-slate-400"
              style={{ left: `${t.leftPct}%` }}
            >
              {t.label}
            </div>
          ))}
        </div>
      </div>

      {/* Rows */}
      <div className="divide-y divide-slate-100">
        {rows.map((row) => (
          <ManifestRowView key={row.activityId} row={row} win={win} ticks={ticks} />
        ))}
      </div>
    </div>
  );
}

function ManifestRowView({
  row,
  win,
  ticks,
}: {
  row: ManifestRow;
  win: DayWindow;
  ticks: ReturnType<typeof hourTicks>;
}) {
  const { laned, laneCount } = assignLanes(row.bookings);
  const trackHeight = laneCount * LANE_HEIGHT + (laneCount - 1) * LANE_GAP;
  const fg = readableTextColor(row.color);

  return (
    <div className="flex">
      {/* Label cell */}
      <div className={cn('shrink-0 border-r border-slate-100 px-4 py-3', LABEL_WIDTH)}>
        <div className="flex items-center gap-2">
          <span
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-bold"
            style={{ backgroundColor: row.color, color: fg }}
            aria-hidden
          >
            {row.activityName.slice(0, 2).toUpperCase()}
          </span>
          <span className="truncate text-sm font-semibold text-slate-800" title={row.activityName}>
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
              className="absolute inset-y-0 w-px bg-slate-100"
              style={{ left: `${t.leftPct}%` }}
            />
          ))}
        </div>

        {/* Blocks */}
        <div className="relative" style={{ height: trackHeight }}>
          {row.bookings.length === 0 ? (
            <div className="flex h-full items-center text-xs text-slate-300">No bookings</div>
          ) : (
            laned.map(({ booking, lane }) => (
              <BookingBlock
                key={booking.orderItemId}
                booking={booking}
                color={row.color}
                window={win}
                lane={lane}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
