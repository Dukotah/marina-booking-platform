// @marina/core — rental-window math for the admin week grid.
//
// A rental Activity (a boat let out by the hour) carries one or more rental
// ScheduleRules: each is "open 8:00 AM–8:00 PM, Mon–Fri, May 1 through Sep 30".
// The admin week grid shades the hours a boat is rentable; this module is the
// one, tested place that answers "is this boat rentable at minute M on the
// local day D?" so the grid and any future caller agree.
//
// Pure + dependency-free: inputs are already-decoded numbers and ISO dates, so
// this is trivially unit-testable and carries no timezone or Prisma coupling.
// Season bounds are compared as YYYY-MM-DD strings (lexicographic order matches
// calendar order for zero-padded ISO dates), and weekday is 0=Sun..6=Sat.

/** The slice of a rental ScheduleRule this math needs. */
export interface RentalWindowRule {
  /** Inclusive first calendar day the rule applies, YYYY-MM-DD. */
  startDate: string;
  /** Inclusive last calendar day the rule applies, YYYY-MM-DD. */
  endDate: string;
  /** Local days the rule covers: 0=Sun … 6=Sat. */
  weekdays: number[];
  /** Open edge, minutes since local midnight (e.g. 8:00 AM = 480). */
  openMinute: number | null;
  /** Close edge, minutes since local midnight (e.g. 8:00 PM = 1200). */
  closeMinute: number | null;
  /** Paused rules contribute nothing. */
  isActive: boolean;
}

/** A half-open rentable span [open, close) in minutes since local midnight. */
export interface MinuteRange {
  open: number;
  close: number;
}

/** 0=Sun..6=Sat for a YYYY-MM-DD day (pure calendar arithmetic, tz-agnostic). */
export function isoWeekday(iso: string): number {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** True when a rule is an active, well-formed rental window (open < close). */
function isUsableWindow(rule: RentalWindowRule): rule is RentalWindowRule & {
  openMinute: number;
  closeMinute: number;
} {
  return (
    rule.isActive &&
    rule.openMinute !== null &&
    rule.closeMinute !== null &&
    rule.closeMinute > rule.openMinute
  );
}

/**
 * The rentable minute-ranges on one specific local calendar day, merged across
 * every rule that covers that day (overlapping windows are unioned). Returns a
 * sorted, non-overlapping list of half-open [open, close) spans. Empty = closed.
 *
 * Blackout days are NOT consulted here — the grid layers whole-day closures on
 * top of this, since a closed day still has a "normal" pattern worth showing
 * struck through.
 */
export function rentableRangesForDay(
  rules: readonly RentalWindowRule[],
  isoDate: string,
): MinuteRange[] {
  const weekday = isoWeekday(isoDate);
  const spans: MinuteRange[] = [];
  for (const rule of rules) {
    if (!isUsableWindow(rule)) continue;
    if (isoDate < rule.startDate || isoDate > rule.endDate) continue;
    if (!rule.weekdays.includes(weekday)) continue;
    spans.push({ open: rule.openMinute, close: rule.closeMinute });
  }
  return mergeRanges(spans);
}

/** Union overlapping/adjacent [open, close) spans into a sorted minimal set. */
export function mergeRanges(spans: readonly MinuteRange[]): MinuteRange[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.open - b.open || a.close - b.close);
  const out: MinuteRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = out[out.length - 1];
    const next = sorted[i];
    if (next.open <= last.close) {
      // Overlapping or touching — extend the open span.
      if (next.close > last.close) last.close = next.close;
    } else {
      out.push({ ...next });
    }
  }
  return out;
}

/**
 * Is the boat rentable at `minute` (minutes since local midnight) on `isoDate`?
 * Half-open: a window of 8:00 AM–8:00 PM (480..1200) is rentable at 480 up to
 * but not including 1200, so the 7:00 PM hour cell counts and the 8:00 PM one
 * does not.
 */
export function isRentableAt(
  rules: readonly RentalWindowRule[],
  isoDate: string,
  minute: number,
): boolean {
  return rentableRangesForDay(rules, isoDate).some(
    (r) => minute >= r.open && minute < r.close,
  );
}

/**
 * Does any part of the hour starting at `hourStartMinute` fall inside a rentable
 * window on `isoDate`? The week grid shades whole hour cells, so a cell counts
 * as rentable when the [hourStart, hourStart+60) hour slice intersects any
 * rentable span — a window opening at 8:30 still lights the 8:00 cell.
 */
export function isHourRentable(
  rules: readonly RentalWindowRule[],
  isoDate: string,
  hourStartMinute: number,
): boolean {
  const hourEnd = hourStartMinute + 60;
  return rentableRangesForDay(rules, isoDate).some(
    (r) => r.open < hourEnd && r.close > hourStartMinute,
  );
}

// ---------------------------------------------------------------------------
// Booking-engine consumer: free gaps + bookable start times.
//
// The admin grid above answers "is minute M rentable?". The booking engine needs
// the inverse: given the day's rentable windows AND the spans already taken by
// existing bookings on this boat, what sub-windows are still FREE, and — for a
// rate of a fixed duration — at what minutes can a rental of that length START?
//
// All half-open [start, close) math, minute-resolution, pure. Spans in == spans
// out == the same half-open convention the ResourceBooking overlap engine uses, so
// the display here can never promise a start the booking path would then refuse.
// ---------------------------------------------------------------------------

/**
 * Subtract a set of taken spans from the rentable ranges, leaving the FREE
 * sub-windows. Taken spans are merged first (so overlapping bookings don't
 * double-count), then carved out of each rentable range. A span that pokes past a
 * range's edges only clips the overlap; a range fully covered yields nothing.
 *
 * Returns a sorted, non-overlapping list of [open, close) gaps — each a stretch of
 * that day during which the boat is both rentable AND unbooked.
 */
export function freeRangesForDay(
  rentable: readonly MinuteRange[],
  taken: readonly MinuteRange[],
): MinuteRange[] {
  const busy = mergeRanges(taken);
  const out: MinuteRange[] = [];
  for (const window of rentable) {
    // Walk a cursor across [open, close), emitting the gaps between busy spans.
    let cursor = window.open;
    for (const b of busy) {
      if (b.close <= cursor) continue; // entirely before the cursor
      if (b.open >= window.close) break; // past this window — later busy spans too
      const gapEnd = Math.min(b.open, window.close);
      if (gapEnd > cursor) out.push({ open: cursor, close: gapEnd });
      cursor = Math.max(cursor, b.close);
      if (cursor >= window.close) break;
    }
    if (cursor < window.close) out.push({ open: cursor, close: window.close });
  }
  return out;
}

/**
 * The minutes-since-midnight at which a rental of `durationMinutes` can START so
 * that the whole [start, start+duration) fits inside one free gap. Candidate
 * starts are stepped by `stepMinutes` from each gap's open edge (default 30-min
 * grid, the granularity a dock desk actually books at), plus the last start that
 * still fits flush against the gap's close so a gap exactly one rental long always
 * offers its one slot.
 *
 * Deduped + ascending. Empty when nothing fits (duration longer than every gap).
 */
export function bookableStartMinutes(
  free: readonly MinuteRange[],
  durationMinutes: number,
  stepMinutes = 30,
): number[] {
  if (durationMinutes <= 0) return [];
  const step = stepMinutes > 0 ? stepMinutes : 30;
  const starts = new Set<number>();
  for (const gap of free) {
    const latest = gap.close - durationMinutes; // last start that still fits
    if (latest < gap.open) continue; // the rental is longer than this gap
    for (let m = gap.open; m <= latest; m += step) starts.add(m);
    // Always offer the flush-to-close start so a gap that is an exact multiple-off
    // of the step still exposes its final slot (e.g. a 3h gap, 2h rental, 30-min
    // grid offers 0:00 and 1:00 — and this adds the 1:00 flush start too).
    starts.add(latest);
  }
  return [...starts].sort((a, b) => a - b);
}

/**
 * True when [startMinute, startMinute+durationMinutes) fits entirely inside one of
 * the free gaps — the exact predicate the booking path validates a requested start
 * against (open-window membership AND not-already-taken, in one check).
 */
export function fitsInFreeRange(
  free: readonly MinuteRange[],
  startMinute: number,
  durationMinutes: number,
): boolean {
  const end = startMinute + durationMinutes;
  return free.some((g) => startMinute >= g.open && end <= g.close);
}
