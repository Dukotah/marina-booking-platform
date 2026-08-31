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
  /** The timeslot this booking sits in — lets the day view group guests by departure. */
  timeslotId: string;
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
  /** Outstanding balance on the parent order, in integer cents (collect at check-in). */
  balanceDueCents: number;
  /** Customer phone for quick contact from the dock, if on file. */
  customerPhone: string | null;
}

/** One booking flattened with its activity context, for the dense list view. */
export interface ManifestListItem extends ManifestBooking {
  activityId: string;
  activityName: string;
  color: string;
}

/** A manifest row: one activity and all of its bookings for the day. */
/** A guide scheduled to run a given timeslot (day-of ops). */
export interface ManifestGuide {
  assignmentId: string;
  guideId: string;
  guideName: string | null;
  guideEmail: string;
  roleLabel: string | null;
}

/** Per-timeslot fill for the "1/3" utilization badges + conflict highlight. */
export interface ManifestSlot {
  timeslotId: string;
  /** ISO start (operator-local wall clock as rendered). */
  startISO: string;
  /** Minutes since midnight for the slot start. */
  startMin: number;
  capacityTotal: number;
  capacityBooked: number;
  /** Guides scheduled on this slot. */
  guides: ManifestGuide[];
}

export interface ManifestRow {
  activityId: string;
  activityName: string;
  /** Hex color from the activity record (white-label, never platform-default). */
  color: string;
  /** Sum of capacity_total across the day's timeslots for this activity. */
  capacityTotal: number;
  /** Sum of capacity_booked across the day's timeslots for this activity. */
  capacityBooked: number;
  /** Per-timeslot fill for utilization badges + conflict detection. */
  slots: ManifestSlot[];
  /** Distinct guides scheduled across this activity's slots for the day. */
  guides: ManifestGuide[];
  bookings: ManifestBooking[];
}

/** True when a status still allows a one-click check-in action. */
export function isCheckInable(status: OrderItemStatus): boolean {
  return status === 'UPCOMING';
}

/** WCAG relative luminance of an sRGB channel (0-255). */
function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 relative luminance of a #rrggbb / #rgb colour. */
function relativeLuminance(hex: string): number {
  const c = hex.replace('#', '');
  const full =
    c.length === 3
      ? c
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : c.padEnd(6, '0').slice(0, 6);
  const r = channelLuminance(parseInt(full.slice(0, 2), 16));
  const g = channelLuminance(parseInt(full.slice(2, 4), 16));
  const b = channelLuminance(parseInt(full.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two relative luminances. */
function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Pick a readable foreground (text) colour for a given hex background.
 *
 * Activity colours are operator-supplied white-label data, so this runs against
 * colours nobody here has ever seen. It used to split on a perceived-luminance
 * (YIQ >= 140) threshold, which is not a contrast measurement: for the shipped
 * default brand `#0ea5e9` it returns white at 2.8:1, under the 4.5:1 floor. It now
 * measures the actual ratio and takes the first candidate that clears AA.
 *
 * A passing candidate always exists: for any background, the better of black and
 * white is at least 4.58:1, so the final fallback is a floor and not a guess.
 * (1.4.3 Contrast (Minimum))
 */
export function readableTextColor(hex: string): string {
  const bg = relativeLuminance(hex);
  const near = relativeLuminance('#0f172a');
  const white = relativeLuminance('#ffffff');
  if (contrastRatio(near, bg) >= 4.5) return '#0f172a';
  if (contrastRatio(white, bg) >= 4.5) return '#ffffff';
  // Neither slate-900 nor white clears AA (a mid-tone background). Take whichever
  // is further away rather than keeping a preference that measured worse.
  return contrastRatio(near, bg) >= contrastRatio(white, bg) ? '#0f172a' : '#ffffff';
}
