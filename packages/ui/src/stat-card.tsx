import { forwardRef } from 'react';
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from 'lucide-react';
import { cn } from './cn.js';

export interface StatCardProps
  extends React.HTMLAttributes<HTMLDivElement> {
  /** Metric label, e.g. "Revenue (MTD)". */
  label: React.ReactNode;
  /** Primary value, already formatted (e.g. via formatUSD). */
  value: React.ReactNode;
  /** Optional period-over-period change. */
  delta?: {
    /** Numeric magnitude (e.g. 12.5 for 12.5%). */
    value: number;
    /** Direction of the change. Defaults to inferring from sign of `value`. */
    direction?: 'up' | 'down';
    /** Suffix appended to the magnitude, e.g. "%". Defaults to "%". */
    suffix?: string;
    /** When true, a downward delta is styled positively (e.g. cancellations). */
    invertColor?: boolean;
  };
  /** Optional lucide icon shown in the corner. */
  icon?: LucideIcon;
}

/** A compact metric tile for dashboards. */
export const StatCard = forwardRef<HTMLDivElement, StatCardProps>(
  ({ className, label, value, delta, icon: Icon, ...props }, ref) => {
    const direction =
      delta?.direction ?? (delta && delta.value < 0 ? 'down' : 'up');
    const isPositive = delta?.invertColor
      ? direction === 'down'
      : direction === 'up';
    const DeltaIcon = direction === 'up' ? ArrowUpRight : ArrowDownRight;
    const magnitude = delta ? Math.abs(delta.value) : 0;

    return (
      <div
        ref={ref}
        className={cn(
          'flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-5 shadow-sm',
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium text-slate-500">{label}</span>
          {Icon ? (
            <Icon className="h-5 w-5 text-slate-400" aria-hidden />
          ) : null}
        </div>
        <div className="flex items-end justify-between gap-2">
          <span className="text-2xl font-semibold tracking-tight text-slate-900">
            {value}
          </span>
          {delta ? (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 text-sm font-medium',
                isPositive ? 'text-emerald-600' : 'text-red-600',
              )}
            >
              <DeltaIcon className="h-4 w-4" aria-hidden />
              {magnitude}
              {delta.suffix ?? '%'}
            </span>
          ) : null}
        </div>
      </div>
    );
  },
);
StatCard.displayName = 'StatCard';
