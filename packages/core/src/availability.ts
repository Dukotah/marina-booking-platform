/**
 * Availability + timeslot generation. Category-agnostic: works for boats, rooms,
 * tours, classes — anything backed by a capacity number.
 */

export type SlotStatus = 'AVAILABLE' | 'FILLING_UP' | 'FULL';

/** Fraction of capacity at/above which a slot is considered "filling up". */
const FILLING_UP_THRESHOLD = 0.7;

/**
 * Derive a slot's display status from its capacity numbers.
 *   - FULL        when booked >= total (or total <= 0, i.e. nothing to sell)
 *   - FILLING_UP  when booked is at or above 70% of total
 *   - AVAILABLE   otherwise
 */
export const computeSlotStatus = (
  capacityTotal: number,
  capacityBooked: number,
): SlotStatus => {
  if (capacityTotal <= 0) return 'FULL';
  if (capacityBooked >= capacityTotal) return 'FULL';
  if (capacityBooked >= capacityTotal * FILLING_UP_THRESHOLD) return 'FILLING_UP';
  return 'AVAILABLE';
};

export interface GenerateTimeslotsInput {
  /** Opening hour in 24h local time (e.g. 8 = 8:00 AM). */
  openHour: number;
  /** Closing hour in 24h local time (e.g. 18 = 6:00 PM). Slots start strictly before this. */
  closeHour: number;
  /** Minutes between successive slot start times (e.g. 30, 60, 240). */
  intervalMinutes: number;
  /** Calendar day to generate slots for. Only the date portion is used. */
  date: Date;
  /** Capacity assigned to every generated slot. */
  capacityTotal: number;
}

export interface GeneratedTimeslot {
  datetime: Date;
  capacityTotal: number;
}

/**
 * Generate evenly-spaced timeslots for a single day between openHour and closeHour.
 * A slot is created at each interval whose start time is strictly before closeHour;
 * the closing time itself is never a bookable start. Returns an empty array for
 * non-positive intervals or when the window is empty/inverted.
 */
export const generateTimeslots = (input: GenerateTimeslotsInput): GeneratedTimeslot[] => {
  const { openHour, closeHour, intervalMinutes, date, capacityTotal } = input;

  if (intervalMinutes <= 0 || closeHour <= openHour) return [];

  const slots: GeneratedTimeslot[] = [];
  const startMinutes = openHour * 60;
  const endMinutes = closeHour * 60;

  for (let m = startMinutes; m < endMinutes; m += intervalMinutes) {
    const slotDate = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      Math.floor(m / 60),
      m % 60,
      0,
      0,
    );
    slots.push({ datetime: slotDate, capacityTotal });
  }

  return slots;
};
