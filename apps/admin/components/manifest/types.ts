import type { OrderItemStatus } from '@marina/database';
import type { MinuteRange } from '@marina/core';

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
  /** Minutes since midnight for the derived slot end (start + rate duration),
   *  clamped to 24:00 for same-day timeline positioning. */
  endMin: number;
  /** Wall-clock return time in minutes since midnight — the honest end even for a
   *  rate that runs past midnight (a 24h overnight from 8am returns 8am → 480). */
  returnMin: number;
  /** True when the rate duration runs past midnight into the next day. */
  endsNextDay: boolean;
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

/**
 * The front desk's glanceable stats, each also a one-tap filter on the day list:
 * who's still coming, who's in, who owes money, who hasn't signed, who's in line.
 */
export type ManifestStatFilter = 'arriving' | 'checkedIn' | 'due' | 'unsigned' | 'waiting';

/** True when a booking matches a booking-level stat filter (not 'waiting', which is
 *  per-slot). Mirrors the counts the stat row shows so glance total and list agree. */
export function bookingMatchesFilter(b: ManifestBooking, filter: ManifestStatFilter): boolean {
  switch (filter) {
    case 'arriving':
      return b.status === 'UPCOMING';
    case 'checkedIn':
      return b.status === 'CHECKED_IN';
    case 'due':
      return b.balanceDueCents > 0 && b.status !== 'NO_SHOW';
    case 'unsigned':
      return !b.waiverSigned && (b.status === 'UPCOMING' || b.status === 'CHECKED_IN');
    case 'waiting':
      // 'waiting' is a slot-level concept (the waitlist), not a booking predicate;
      // DaySchedule handles it by keeping full slots with a waitlist.
      return true;
  }
}

/** One guest waiting on a sold-out slot, as the departure card lists them. */
export interface ManifestWaitlistEntry {
  id: string;
  name: string;
  email: string;
  /** PENDING = still waiting; NOTIFIED = already emailed a booking link. */
  status: 'PENDING' | 'NOTIFIED';
}

/** Per-timeslot fill for the "1/3" utilization badges + conflict highlight. */
export interface ManifestSlot {
  timeslotId: string;
  /** ISO start (operator-local wall clock as rendered). */
  startISO: string;
  /** Minutes since midnight for the slot start. */
  startMin: number;
  /** Minutes since midnight for the slot end (start + representative rate
   *  duration), clamped to 24:00 — mirrors how a booking's endMin is derived so
   *  an OPEN block spans the same width a booking on this slot would. */
  endMin: number;
  capacityTotal: number;
  capacityBooked: number;
  /** Guides scheduled on this slot. */
  guides: ManifestGuide[];
  /** Guests waiting for a spot on this slot (oldest first). */
  waitlist: ManifestWaitlistEntry[];
}

/**
 * A closed / out-of-service window on an activity row, for the Timeline board.
 *
 * Marina closures are modeled as whole-day BlackoutDate rows (an activity-scoped
 * blackout closes just that boat; an operator/location-wide one closes every
 * boat that day) — there is no partial-span closure in the data, so every closed
 * region a row carries is a full-day one. See app/manifest/data.ts.
 */
export interface ManifestClosure {
  /** Why the boat is down, when known ("Engine service", "Holiday"). */
  reason: string | null;
  /** True = operator/location-wide blackout (not scoped to this one boat). */
  wide: boolean;
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
  /**
   * Full-day closures in effect for this boat on this day (BlackoutDate rows).
   * Empty = open for business. The Timeline shades the whole row when present.
   */
  closures: ManifestClosure[];
  /**
   * OPEN-DURATION RENTAL AVAILABILITY for this boat on this day, as a set of
   * half-open [open, close) minute spans still FREE to rent — the day's rentable
   * window(s) from the boat's active rental-window ScheduleRules (open_minute/
   * close_minute, matching this weekday + season), with any whole-day blackout
   * removed and existing bookings carved out. Drawn as a continuous teal "available
   * to rent" band behind the blocks.
   *
   * Empty on fixed-departure tour boats (no rental-window rule) — those keep the
   * discrete "+N open slot" behavior instead. See app/manifest/data.ts.
   */
  rentableBands: MinuteRange[];
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
