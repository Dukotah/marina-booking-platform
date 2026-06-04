import { describe, expect, it } from 'vitest';
import { computeSlotStatus, generateTimeslots } from './availability.js';

describe('computeSlotStatus', () => {
  it('is AVAILABLE when nothing is booked', () => {
    expect(computeSlotStatus(10, 0)).toBe('AVAILABLE');
  });

  it('is AVAILABLE just below the 70% filling-up threshold', () => {
    // 6 / 10 = 60% < 70%
    expect(computeSlotStatus(10, 6)).toBe('AVAILABLE');
  });

  it('is FILLING_UP exactly at the 70% threshold', () => {
    // 7 / 10 = 70%
    expect(computeSlotStatus(10, 7)).toBe('FILLING_UP');
  });

  it('is FILLING_UP above the threshold but below full', () => {
    expect(computeSlotStatus(10, 9)).toBe('FILLING_UP');
  });

  it('is FULL when booked equals total', () => {
    expect(computeSlotStatus(10, 10)).toBe('FULL');
  });

  it('is FULL when booked exceeds total (overbooked)', () => {
    expect(computeSlotStatus(10, 12)).toBe('FULL');
  });

  it('is FULL when there is no capacity to sell', () => {
    expect(computeSlotStatus(0, 0)).toBe('FULL');
    expect(computeSlotStatus(-5, 0)).toBe('FULL');
  });

  it('handles fractional thresholds (capacity not divisible by 10)', () => {
    // threshold = 7 * 0.7 = 4.9 -> 4 booked is below, 5 is at/above
    expect(computeSlotStatus(7, 4)).toBe('AVAILABLE');
    expect(computeSlotStatus(7, 5)).toBe('FILLING_UP');
  });

  it('treats a single-capacity slot as full once booked', () => {
    expect(computeSlotStatus(1, 0)).toBe('AVAILABLE');
    expect(computeSlotStatus(1, 1)).toBe('FULL');
  });
});

describe('generateTimeslots', () => {
  const date = new Date(2026, 5, 4); // 2026-06-04, local

  it('generates one slot per interval, ending strictly before close', () => {
    const slots = generateTimeslots({
      openHour: 8,
      closeHour: 18,
      intervalMinutes: 60,
      date,
      capacityTotal: 5,
    });
    // 8,9,...,17 -> 10 slots; 18:00 is never a bookable start
    expect(slots).toHaveLength(10);
    expect(slots[0].datetime.getHours()).toBe(8);
    expect(slots[slots.length - 1].datetime.getHours()).toBe(17);
  });

  it('counts 30-minute slots correctly', () => {
    const slots = generateTimeslots({
      openHour: 9,
      closeHour: 12,
      intervalMinutes: 30,
      date,
      capacityTotal: 2,
    });
    // 9:00 .. 11:30 -> 6 slots
    expect(slots).toHaveLength(6);
  });

  it('counts 4-hour (240-minute) slots correctly', () => {
    const slots = generateTimeslots({
      openHour: 8,
      closeHour: 16,
      intervalMinutes: 240,
      date,
      capacityTotal: 3,
    });
    // 8:00 and 12:00 -> 2 slots
    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.datetime.getHours())).toEqual([8, 12]);
  });

  it('assigns the given capacity to every slot', () => {
    const slots = generateTimeslots({
      openHour: 10,
      closeHour: 13,
      intervalMinutes: 60,
      date,
      capacityTotal: 7,
    });
    expect(slots.every((s) => s.capacityTotal === 7)).toBe(true);
  });

  it('anchors slots to the provided calendar day with zeroed seconds', () => {
    const slots = generateTimeslots({
      openHour: 9,
      closeHour: 11,
      intervalMinutes: 90,
      date,
      capacityTotal: 1,
    });
    const first = slots[0].datetime;
    expect(first.getFullYear()).toBe(2026);
    expect(first.getMonth()).toBe(5);
    expect(first.getDate()).toBe(4);
    expect(first.getHours()).toBe(9);
    expect(first.getMinutes()).toBe(0);
    expect(first.getSeconds()).toBe(0);
    expect(first.getMilliseconds()).toBe(0);

    // 9:00 + 90min = 10:30
    const second = slots[1].datetime;
    expect(second.getHours()).toBe(10);
    expect(second.getMinutes()).toBe(30);
  });

  it('returns an empty array for a non-positive interval', () => {
    expect(
      generateTimeslots({
        openHour: 8,
        closeHour: 18,
        intervalMinutes: 0,
        date,
        capacityTotal: 5,
      }),
    ).toEqual([]);
    expect(
      generateTimeslots({
        openHour: 8,
        closeHour: 18,
        intervalMinutes: -30,
        date,
        capacityTotal: 5,
      }),
    ).toEqual([]);
  });

  it('returns an empty array for an inverted or empty window', () => {
    expect(
      generateTimeslots({
        openHour: 18,
        closeHour: 8,
        intervalMinutes: 60,
        date,
        capacityTotal: 5,
      }),
    ).toEqual([]);
    expect(
      generateTimeslots({
        openHour: 10,
        closeHour: 10,
        intervalMinutes: 60,
        date,
        capacityTotal: 5,
      }),
    ).toEqual([]);
  });

  it('includes a final slot when the interval does not divide the window evenly', () => {
    const slots = generateTimeslots({
      openHour: 8,
      closeHour: 11,
      intervalMinutes: 45,
      date,
      capacityTotal: 1,
    });
    // 8:00, 8:45, 9:30, 10:15 -> next would be 11:00 (== close, excluded) => 4 slots
    expect(slots).toHaveLength(4);
    const last = slots[slots.length - 1].datetime;
    expect(last.getHours()).toBe(10);
    expect(last.getMinutes()).toBe(15);
  });
});
