import type { OrderItemStatus } from '@marina/database';

/**
 * View-model types shared between the manifest page (server) and its client
 * components. These are deliberately plain/serializable so the server component can
 * pass them across the client boundary without leaking Prisma model instances.
 */

/** A single booking block on a manifest row. */
export interface ManifestBooking {
  orderItemId: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  /** Rate label, e.g. "Half Day". */
  rateName: string;
  quantity: number;
  status: OrderItemStatus;
  /** Minutes since midnight for the slot start. */
  startMin: number;
  /** Minutes since midnight for the derived slot end (start + rate duration). */
  endMin: number;
  /** ISO start time for tooltips/labels (operator-local wall clock as rendered). */
  startISO: string;
  waiverSigned: boolean;
}

/** A manifest row: one activity and all of its bookings for the day. */
export interface ManifestRow {
  activityId: string;
  activityName: string;
  /** Hex color from the activity record (white-label, never platform-default). */
  color: string;
  /** Sum of capacity_total across the day's timeslots for this activity. */
  capacityTotal: number;
  /** Sum of capacity_booked across the day's timeslots for this activity. */
  capacityBooked: number;
  bookings: ManifestBooking[];
}

/** True when a status still allows a one-click check-in action. */
export function isCheckInable(status: OrderItemStatus): boolean {
  return status === 'UPCOMING';
}

/**
 * Pick readable foreground (text) color for a given hex background. Uses the
 * perceived-luminance (YIQ) heuristic so labels stay legible on any activity color.
 */
export function readableTextColor(hex: string): string {
  const c = hex.replace('#', '');
  const full =
    c.length === 3
      ? c
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : c.padEnd(6, '0').slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 140 ? '#0f172a' : '#ffffff';
}
