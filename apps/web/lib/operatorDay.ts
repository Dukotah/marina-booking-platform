/**
 * Operator-calendar day helpers, shared by the activity page (server) and the
 * booking widgets (client).
 *
 * The strip, the seeded availability window, and "is this departure already
 * gone?" all have to agree on WHOSE clock decides. The rule (same as commit
 * 7ec5d9e, which fixed the server half): calendar DAYS are bucketed in the
 * operator's timezone — a guest browsing from another timezone books the
 * marina's Tuesday, not their own — while past/future is a plain instant
 * comparison, which needs no timezone at all (slot datetimes are UTC instants).
 */

/**
 * The calendar day `offsetDays` from now, as `YYYY-MM-DD`, evaluated in
 * `timeZone`. en-CA renders YYYY-MM-DD directly.
 */
export function operatorDayISO(timeZone: string, offsetDays = 0): string {
  const base = new Date(Date.now() + offsetDays * 86_400_000);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(base);
  } catch {
    // An invalid/unknown zone id must never take the funnel down; fall back to
    // the environment's local day, exactly what the UI did before timezone
    // awareness existed.
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(base);
  }
}

/**
 * The slots whose departure instant is still ahead of the clock.
 *
 * Timezone-independent on purpose: `datetime` is a UTC instant and so is
 * `nowMs`. The operator timezone's only job is deciding which slots belong to
 * "today" — by the time a day's slots are in hand, past-vs-future is pure
 * instant math.
 */
export function futureSlots<T extends { datetime: string }>(
  slots: T[],
  nowMs: number = Date.now(),
): T[] {
  return slots.filter((s) => new Date(s.datetime).getTime() > nowMs);
}
