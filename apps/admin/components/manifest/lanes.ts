import type { ManifestBooking } from './types';

/**
 * Assign each booking to a vertical "lane" within its activity row so overlapping
 * time intervals stack instead of colliding. Greedy interval-graph coloring:
 * sort by start, then place each block in the first lane whose last block has
 * already ended. Returns the per-booking lane index and the total lane count for
 * sizing the row.
 */
export interface LanedBooking {
  booking: ManifestBooking;
  lane: number;
}

export function assignLanes(bookings: ManifestBooking[]): {
  laned: LanedBooking[];
  laneCount: number;
} {
  const sorted = [...bookings].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const laneEnds: number[] = []; // laneEnds[i] = end minute of the last block in lane i
  const laned: LanedBooking[] = [];

  for (const booking of sorted) {
    let placed = -1;
    for (let i = 0; i < laneEnds.length; i += 1) {
      if (booking.startMin >= laneEnds[i]) {
        placed = i;
        break;
      }
    }
    if (placed === -1) {
      placed = laneEnds.length;
      laneEnds.push(booking.endMin);
    } else {
      laneEnds[placed] = booking.endMin;
    }
    laned.push({ booking, lane: placed });
  }

  return { laned, laneCount: Math.max(1, laneEnds.length) };
}
