import { computeSlotStatus } from '@marina/core';
import { cn } from '../../lib/cn';

/**
 * Compact capacity meter shown in each manifest row's label cell. Reuses the core
 * `computeSlotStatus` thresholds so the manifest's color signal matches the rest of
 * the platform (green available, amber filling up, red full).
 */
export interface CapacityBarProps {
  booked: number;
  total: number;
}

const STATUS_BAR: Record<'AVAILABLE' | 'FILLING_UP' | 'FULL', string> = {
  AVAILABLE: 'bg-emerald-500',
  FILLING_UP: 'bg-amber-500',
  FULL: 'bg-rose-500',
};

export function CapacityBar({ booked, total }: CapacityBarProps) {
  const status = computeSlotStatus(total, booked);
  const pct = total > 0 ? Math.min(100, Math.round((booked / total) * 100)) : 0;

  return (
    <div className="mt-1.5">
      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span>
          {booked}/{total > 0 ? total : '—'} booked
        </span>
        <span className="tabular-nums">{total > 0 ? `${pct}%` : ''}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className={cn('h-full rounded-full transition-all', STATUS_BAR[status])}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
