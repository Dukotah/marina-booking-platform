import type { LucideIcon } from 'lucide-react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface KpiCardProps {
  label: string;
  /** Pre-formatted value (e.g. formatUSD(cents), "42%", "128"). */
  value: string;
  /** Optional leading icon for the metric. */
  icon?: LucideIcon;
  /**
   * Optional period-over-period delta as a signed ratio (e.g. 0.12 = +12%).
   * Positive renders green/up, negative red/down, zero neutral.
   */
  deltaRatio?: number;
  /** Label for what the delta compares against, e.g. "vs last week". */
  deltaLabel?: string;
  className?: string;
}

/**
 * Dashboard KPI tile. The dashboard-first experience (revenue/occupancy at a
 * glance) is our core wedge over Singenuity's raw manifest dump.
 */
export function KpiCard({
  label,
  value,
  icon: Icon,
  deltaRatio,
  deltaLabel,
  className,
}: KpiCardProps) {
  const hasDelta = typeof deltaRatio === 'number' && Number.isFinite(deltaRatio);
  const positive = hasDelta && deltaRatio! > 0;
  const negative = hasDelta && deltaRatio! < 0;
  const DeltaIcon = positive ? ArrowUpRight : negative ? ArrowDownRight : null;

  return (
    <div
      className={cn(
        'rounded-xl border border-slate-200 bg-white p-5 shadow-sm',
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <span className="text-sm font-medium text-slate-500">{label}</span>
        {Icon ? (
          <span className="rounded-lg bg-slate-100 p-2 text-slate-500">
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        ) : null}
      </div>

      <div className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">{value}</div>

      {hasDelta ? (
        <div className="mt-2 flex items-center gap-1 text-xs">
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-medium',
              positive && 'text-emerald-600',
              negative && 'text-red-600',
              !positive && !negative && 'text-slate-500',
            )}
          >
            {DeltaIcon ? <DeltaIcon className="h-3.5 w-3.5" aria-hidden /> : null}
            {`${deltaRatio! > 0 ? '+' : ''}${(deltaRatio! * 100).toFixed(1)}%`}
          </span>
          {deltaLabel ? <span className="text-slate-400">{deltaLabel}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
