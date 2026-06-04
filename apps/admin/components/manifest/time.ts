/**
 * Time-axis math shared by the Gantt manifest. All functions are pure and work in
 * the operator's wall-clock terms (callers pass already-localized Date values).
 *
 * The manifest renders a single day as a horizontal time axis. A booking block is
 * placed by converting its start (and end, derived from the rate duration) into a
 * left offset + width expressed as a percentage of the visible window. Keeping the
 * geometry here means both the server component and the client interaction layer
 * agree on positions.
 */

/** Minutes since midnight for a Date, in local (already-resolved) terms. */
export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export interface DayWindow {
  /** First hour shown on the axis (24h, e.g. 7 = 7:00 AM). */
  startHour: number;
  /** Last hour shown on the axis (24h, exclusive upper bound, e.g. 21 = 9:00 PM). */
  endHour: number;
}

/** Total minutes spanned by the visible window. */
export function windowMinutes(win: DayWindow): number {
  return Math.max(0, (win.endHour - win.startHour) * 60);
}

/**
 * Clamp a [startMin, endMin] booking interval to the window and express it as
 * left/width percentages of the window. Returns null when the interval falls
 * entirely outside the window (so the caller can skip rendering it).
 */
export function blockGeometry(
  startMin: number,
  endMin: number,
  win: DayWindow,
): { leftPct: number; widthPct: number } | null {
  const winStart = win.startHour * 60;
  const total = windowMinutes(win);
  if (total <= 0) return null;

  const clampedStart = Math.max(startMin, winStart);
  const clampedEnd = Math.min(endMin, win.endHour * 60);
  if (clampedEnd <= clampedStart) return null;

  const leftPct = ((clampedStart - winStart) / total) * 100;
  const widthPct = ((clampedEnd - clampedStart) / total) * 100;
  return { leftPct, widthPct };
}

/**
 * Hour tick marks for the axis header, inclusive of both ends. Each tick carries
 * its own left offset so the header and the row grid line up exactly.
 */
export function hourTicks(win: DayWindow): Array<{ hour: number; leftPct: number; label: string }> {
  const ticks: Array<{ hour: number; leftPct: number; label: string }> = [];
  const total = windowMinutes(win);
  if (total <= 0) return ticks;

  for (let h = win.startHour; h <= win.endHour; h += 1) {
    const leftPct = (((h - win.startHour) * 60) / total) * 100;
    ticks.push({ hour: h, leftPct, label: formatHourLabel(h) });
  }
  return ticks;
}

/** "8a", "12p", "3p" — compact 12h label for an axis tick. */
export function formatHourLabel(hour24: number): string {
  const h = ((hour24 + 11) % 12) + 1; // 0->12, 13->1
  const suffix = hour24 < 12 || hour24 === 24 ? 'a' : 'p';
  const normalized = hour24 === 24 ? 12 : h;
  return `${normalized}${suffix}`;
}

/**
 * Compute a sensible visible window from the day's bookings. Defaults to a typical
 * operating window (7a–9p) and expands outward to cover any out-of-window blocks so
 * nothing is ever clipped off-screen.
 */
export function deriveWindow(
  bookings: Array<{ startMin: number; endMin: number }>,
  fallback: DayWindow = { startHour: 7, endHour: 21 },
): DayWindow {
  if (bookings.length === 0) return fallback;

  let minStart = fallback.startHour * 60;
  let maxEnd = fallback.endHour * 60;
  for (const b of bookings) {
    if (b.startMin < minStart) minStart = b.startMin;
    if (b.endMin > maxEnd) maxEnd = b.endMin;
  }

  const startHour = Math.max(0, Math.floor(minStart / 60));
  const endHour = Math.min(24, Math.ceil(maxEnd / 60));
  return { startHour, endHour: Math.max(endHour, startHour + 1) };
}
