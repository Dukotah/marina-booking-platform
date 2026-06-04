import { Anchor } from 'lucide-react';
import { EmptyState } from '@marina/ui';
import { formatNumber, formatPercent } from '../../lib/format';
import type { OccupancySlice } from './queries';

export interface OccupancySnapshotProps {
  capacityTotal: number;
  capacityBooked: number;
  ratio: number; // 0–1
  slices: OccupancySlice[];
}

/** Clamp a ratio to the 0–100% bar width range. */
function barWidth(ratio: number): string {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return `${pct.toFixed(0)}%`;
}

/**
 * Today's occupancy: an aggregate booked/total headline plus a per-activity
 * breakdown with brand-colored fill bars. Each activity uses its own color so
 * the snapshot reads at a glance. Empty (no timeslots today) renders a hint.
 */
export function OccupancySnapshot({
  capacityTotal,
  capacityBooked,
  ratio,
  slices,
}: OccupancySnapshotProps) {
  if (capacityTotal === 0) {
    return (
      <EmptyState
        icon={Anchor}
        title="No timeslots today"
        description="Once activities have scheduled timeslots for today, occupancy shows up here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-3xl font-semibold tracking-tight text-slate-900">
            {formatPercent(ratio)}
          </div>
          <div className="mt-1 text-sm text-slate-500">
            {formatNumber(capacityBooked)} of {formatNumber(capacityTotal)} seats booked today
          </div>
        </div>
      </div>

      <ul className="flex flex-col gap-3">
        {slices.map((s) => {
          const sliceRatio = s.capacityTotal ? s.capacityBooked / s.capacityTotal : 0;
          return (
            <li key={s.activityId} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: s.color }}
                    aria-hidden
                  />
                  <span className="truncate font-medium text-slate-700">
                    {s.activityName}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums text-slate-500">
                  {s.capacityBooked}/{s.capacityTotal}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full"
                  style={{ width: barWidth(sliceRatio), backgroundColor: s.color }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
