import { describe, expect, it } from 'vitest';
import {
  bookableStartMinutes,
  fitsInFreeRange,
  freeRangesForDay,
  isHourRentable,
  isRentableAt,
  isoWeekday,
  mergeRanges,
  rentableRangesForDay,
  type MinuteRange,
  type RentalWindowRule,
} from './rental-window.js';

/** 2026-05-04 is a Monday; 2026-05-09 a Saturday; 2026-05-10 a Sunday. */
const MON = '2026-05-04';
const SAT = '2026-05-09';
const SUN = '2026-05-10';

function rule(partial: Partial<RentalWindowRule>): RentalWindowRule {
  return {
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    weekdays: [1, 2, 3, 4, 5],
    openMinute: 8 * 60,
    closeMinute: 20 * 60,
    isActive: true,
    ...partial,
  };
}

describe('isoWeekday', () => {
  it('maps ISO dates to 0=Sun..6=Sat', () => {
    expect(isoWeekday(MON)).toBe(1);
    expect(isoWeekday(SAT)).toBe(6);
    expect(isoWeekday(SUN)).toBe(0);
  });
});

describe('rentableRangesForDay', () => {
  it('returns the window on a matching weekday inside the season', () => {
    expect(rentableRangesForDay([rule({})], MON)).toEqual([{ open: 480, close: 1200 }]);
  });

  it('is closed on a weekday the rule does not cover', () => {
    expect(rentableRangesForDay([rule({})], SAT)).toEqual([]);
  });

  it('is closed outside the season date range', () => {
    const summer = rule({ startDate: '2026-06-01', endDate: '2026-09-30' });
    expect(rentableRangesForDay([summer], MON)).toEqual([]);
  });

  it('is closed on the day after the season ends and open on the last day', () => {
    const r = rule({ startDate: '2026-05-01', endDate: '2026-05-04' });
    expect(rentableRangesForDay([r], MON)).toEqual([{ open: 480, close: 1200 }]);
    expect(rentableRangesForDay([r], '2026-05-05')).toEqual([]);
  });

  it('ignores paused and malformed rules', () => {
    expect(rentableRangesForDay([rule({ isActive: false })], MON)).toEqual([]);
    expect(rentableRangesForDay([rule({ openMinute: null })], MON)).toEqual([]);
    expect(rentableRangesForDay([rule({ openMinute: 600, closeMinute: 600 })], MON)).toEqual([]);
  });

  it('unions two windows on the same day', () => {
    const morning = rule({ openMinute: 6 * 60, closeMinute: 10 * 60 });
    const evening = rule({ openMinute: 17 * 60, closeMinute: 21 * 60 });
    expect(rentableRangesForDay([morning, evening], MON)).toEqual([
      { open: 360, close: 600 },
      { open: 1020, close: 1260 },
    ]);
  });

  it('merges overlapping windows into one span', () => {
    const a = rule({ openMinute: 8 * 60, closeMinute: 14 * 60 });
    const b = rule({ openMinute: 12 * 60, closeMinute: 18 * 60 });
    expect(rentableRangesForDay([a, b], MON)).toEqual([{ open: 480, close: 1080 }]);
  });
});

describe('mergeRanges', () => {
  it('merges touching spans', () => {
    expect(mergeRanges([{ open: 0, close: 60 }, { open: 60, close: 120 }])).toEqual([
      { open: 0, close: 120 },
    ]);
  });

  it('keeps a gap between non-adjacent spans', () => {
    expect(mergeRanges([{ open: 0, close: 60 }, { open: 120, close: 180 }])).toEqual([
      { open: 0, close: 60 },
      { open: 120, close: 180 },
    ]);
  });
});

describe('isRentableAt', () => {
  const rules = [rule({})]; // Mon–Fri 8:00–20:00
  it('is rentable inside the window', () => {
    expect(isRentableAt(rules, MON, 8 * 60)).toBe(true);
    expect(isRentableAt(rules, MON, 19 * 60)).toBe(true);
  });
  it('is half-open at the close edge', () => {
    expect(isRentableAt(rules, MON, 20 * 60)).toBe(false);
    expect(isRentableAt(rules, MON, 20 * 60 - 1)).toBe(true);
  });
  it('is closed before open', () => {
    expect(isRentableAt(rules, MON, 7 * 60 + 59)).toBe(false);
  });
});

describe('isHourRentable', () => {
  it('lights an hour cell the window partially overlaps', () => {
    const r = [rule({ openMinute: 8 * 60 + 30, closeMinute: 20 * 60 })];
    // 8:00 cell: [480,540) intersects [510,1200) -> true
    expect(isHourRentable(r, MON, 8 * 60)).toBe(true);
    // 7:00 cell: [420,480) does not intersect [510,...) -> false
    expect(isHourRentable(r, MON, 7 * 60)).toBe(false);
  });
  it('does not light the close-edge hour cell when close is on the hour', () => {
    const r = [rule({ openMinute: 8 * 60, closeMinute: 20 * 60 })];
    // 20:00 cell: [1200,1260) vs [480,1200): r.close(1200) > 1200 is false -> closed
    expect(isHourRentable(r, MON, 20 * 60)).toBe(false);
    expect(isHourRentable(r, MON, 19 * 60)).toBe(true);
  });
});

/** 8:00 AM–8:00 PM in minutes: the seeded LSRA rental window. */
const W: MinuteRange = { open: 480, close: 1200 };

describe('freeRangesForDay', () => {
  it('returns the whole window when nothing is taken', () => {
    expect(freeRangesForDay([W], [])).toEqual([{ open: 480, close: 1200 }]);
  });

  it('carves a single taken span out of the middle', () => {
    // A 10:00–12:00 booking (600..720) splits the window in two.
    expect(freeRangesForDay([W], [{ open: 600, close: 720 }])).toEqual([
      { open: 480, close: 600 },
      { open: 720, close: 1200 },
    ]);
  });

  it('clips a booking that pokes past the open edge', () => {
    // A booking 7:00–9:00 (420..540) only removes 8:00–9:00 of the window.
    expect(freeRangesForDay([W], [{ open: 420, close: 540 }])).toEqual([
      { open: 540, close: 1200 },
    ]);
  });

  it('merges overlapping bookings before subtracting', () => {
    // 10–11 and 10:30–12 overlap -> one 10–12 busy span -> one split.
    expect(
      freeRangesForDay([W], [
        { open: 600, close: 660 },
        { open: 630, close: 720 },
      ]),
    ).toEqual([
      { open: 480, close: 600 },
      { open: 720, close: 1200 },
    ]);
  });

  it('is empty when the window is fully booked', () => {
    expect(freeRangesForDay([W], [{ open: 480, close: 1200 }])).toEqual([]);
  });

  it('is adjacency-exact at a booking edge (half-open)', () => {
    // A booking ending exactly at 600 leaves [600,1200) free, not [601,...).
    expect(freeRangesForDay([{ open: 480, close: 1200 }], [{ open: 480, close: 600 }])).toEqual([
      { open: 600, close: 1200 },
    ]);
  });
});

describe('bookableStartMinutes', () => {
  it('steps starts across a free gap on a 30-min grid', () => {
    // Free 8:00–10:00 (480..600), a 1h rental: starts at 8:00, 8:30, 9:00, and the
    // flush-to-close 9:00 again (deduped).
    expect(bookableStartMinutes([{ open: 480, close: 600 }], 60, 30)).toEqual([480, 510, 540]);
  });

  it('always offers the flush-to-close start', () => {
    // Free 8:00–8:50 (480..530), a 20-min rental on a 30-min grid: 8:00 and the
    // flush start 8:30 (530-20=510), which the grid alone would miss.
    expect(bookableStartMinutes([{ open: 480, close: 530 }], 20, 30)).toEqual([480, 510]);
  });

  it('offers nothing when the rental is longer than every gap', () => {
    expect(bookableStartMinutes([{ open: 480, close: 540 }], 120, 30)).toEqual([]);
  });

  it('spans multiple gaps', () => {
    const free = [
      { open: 480, close: 600 }, // 8–10
      { open: 720, close: 780 }, // 12–13
    ];
    // 1h rental: 8:00, 8:30, 9:00 in the first gap; 12:00 only in the second.
    expect(bookableStartMinutes(free, 60, 30)).toEqual([480, 510, 540, 720]);
  });
});

describe('fitsInFreeRange', () => {
  const free = [{ open: 480, close: 600 }];
  it('accepts a rental wholly inside a gap', () => {
    expect(fitsInFreeRange(free, 480, 60)).toBe(true);
    expect(fitsInFreeRange(free, 540, 60)).toBe(true); // flush to close
  });
  it('rejects a rental that spills past the gap close', () => {
    expect(fitsInFreeRange(free, 541, 60)).toBe(false);
  });
  it('rejects a start before any gap', () => {
    expect(fitsInFreeRange(free, 470, 10)).toBe(false);
  });
});
