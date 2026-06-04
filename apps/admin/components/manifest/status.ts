import type { OrderItemStatus } from '@marina/database';

/**
 * Visual treatment per order-item status, used by both the manifest blocks and the
 * calendar chips so the two views read consistently. Returns Tailwind class
 * fragments (ring/badge) layered on top of the activity color.
 */
export interface StatusStyle {
  label: string;
  /** Small badge classes (background + text) for the status pill. */
  badge: string;
  /** Whether the block should render in a "muted" (cancelled/no-show) state. */
  muted: boolean;
}

export const STATUS_STYLES: Record<OrderItemStatus, StatusStyle> = {
  UPCOMING: { label: 'Upcoming', badge: 'bg-slate-100 text-slate-700', muted: false },
  CHECKED_IN: { label: 'Checked in', badge: 'bg-emerald-100 text-emerald-800', muted: false },
  COMPLETED: { label: 'Completed', badge: 'bg-sky-100 text-sky-800', muted: false },
  CANCELLED: { label: 'Cancelled', badge: 'bg-rose-100 text-rose-700', muted: true },
  NO_SHOW: { label: 'No-show', badge: 'bg-amber-100 text-amber-800', muted: true },
};

export function statusStyle(status: OrderItemStatus): StatusStyle {
  return STATUS_STYLES[status] ?? STATUS_STYLES.UPCOMING;
}
