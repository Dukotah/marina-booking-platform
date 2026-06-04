import { cn } from '../../lib/cn';

/** Order lifecycle status (mirrors Prisma `OrderStatus`). */
export type OrderStatusValue = 'UPCOMING' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';

const STYLES: Record<OrderStatusValue, { label: string; className: string }> = {
  UPCOMING: { label: 'Upcoming', className: 'bg-sky-50 text-sky-700 ring-sky-600/20' },
  COMPLETED: { label: 'Completed', className: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  CANCELLED: { label: 'Cancelled', className: 'bg-slate-100 text-slate-600 ring-slate-500/20' },
  NO_SHOW: { label: 'No-show', className: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
};

/**
 * Color-coded order status pill. Visual status signals are part of the wedge over
 * Singenuity's text-wall manifest, so statuses read at a glance.
 */
export function OrderStatusBadge({ status, className }: { status: OrderStatusValue; className?: string }) {
  const style = STYLES[status] ?? STYLES.UPCOMING;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        style.className,
        className,
      )}
    >
      {style.label}
    </span>
  );
}
