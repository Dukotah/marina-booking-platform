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
        'rounded-lg border border-line bg-surface p-5 shadow-sm',
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <span className="text-sm font-medium text-ink-body">{label}</span>
        {Icon ? (
          <span className="rounded-lg bg-surface-muted p-2 text-ink-muted">
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        ) : null}
      </div>

      <div className="mt-3 text-3xl font-semibold tracking-tight text-ink tnum">{value}</div>

      {hasDelta ? (
        <div className="mt-2 flex items-center gap-1 text-xs">
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-medium',
              positive && 'text-emerald-700',
              negative && 'text-rose-600',
              !positive && !negative && 'text-ink-muted',
            )}
          >
            {DeltaIcon ? <DeltaIcon className="h-3.5 w-3.5" aria-hidden /> : null}
            {`${deltaRatio! > 0 ? '+' : ''}${(deltaRatio! * 100).toFixed(1)}%`}
          </span>
          {deltaLabel ? <span className="text-ink-muted">{deltaLabel}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
