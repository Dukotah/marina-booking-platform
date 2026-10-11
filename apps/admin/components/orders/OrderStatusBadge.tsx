import { Badge, type BadgeTone } from '../ui';

/** Order lifecycle status (mirrors Prisma `OrderStatus`). */
export type OrderStatusValue = 'UPCOMING' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';

// Status-color law: UPCOMING is quiet (slate/neutral), COMPLETED is slate (past),
// CANCELLED is slate, NO_SHOW carries a waiting/amber warning. No sky/indigo.
const STYLES: Record<OrderStatusValue, { label: string; tone: BadgeTone }> = {
  UPCOMING: { label: 'Upcoming', tone: 'neutral' },
  COMPLETED: { label: 'Completed', tone: 'cancelled' },
  CANCELLED: { label: 'Cancelled', tone: 'cancelled' },
  NO_SHOW: { label: 'No-show', tone: 'waiting' },
};

/**
 * Color-coded order status pill. Visual status signals are part of the wedge over
 * Singenuity's text-wall manifest, so statuses read at a glance. Built on the
 * shared Badge primitive so tones stay consistent app-wide.
 */
export function OrderStatusBadge({ status, className }: { status: OrderStatusValue; className?: string }) {
  const style = STYLES[status] ?? STYLES.UPCOMING;
  return (
    <Badge tone={style.tone} className={className}>
      {style.label}
    </Badge>
  );
}
