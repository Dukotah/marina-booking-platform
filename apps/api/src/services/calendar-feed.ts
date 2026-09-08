/**
 * iCalendar (RFC 5545) feed builder — pure functions, no I/O.
 *
 * Backs two surfaces:
 *  - the per-operator subscribe feed (`GET /calendar/feed/:token.ics`) that Google
 *    Calendar / Apple Calendar / Outlook poll ("Other calendars → From URL"), and
 *  - the per-booking "add to calendar" download on the customer confirmation page
 *    (`GET /calendar/booking/:orderItemId.ics`).
 *
 * Design notes:
 *  - Everything is emitted in UTC (`YYYYMMDDTHHMMSSZ`). Timeslot datetimes are
 *    stored as UTC instants, so no timezone math is needed here — calendar apps
 *    render the instant in the viewer's zone, which matches what the operator sees.
 *  - UIDs are stable per order item (`<orderItemId>@marina-booking`), so a
 *    subscribed Google Calendar UPDATES an event on reschedule instead of
 *    duplicating it.
 *  - Text values are escaped per RFC 5545 §3.3.11 and content lines are folded at
 *    75 OCTETS (not characters — folding must never split a UTF-8 sequence).
 *  - METHOD:PUBLISH + omitting cancelled bookings keeps subscribe semantics simple:
 *    a cancelled booking just disappears from the feed on the next poll.
 */

// ---------------------------------------------------------------------------
// Primitives (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Escape a text value per RFC 5545 §3.3.11: backslash first, then semicolon and
 * comma; newlines (any flavour) become the literal `\n`.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Fold a single content line at 75 octets (RFC 5545 §3.1). Continuation lines
 * begin with one space and hold at most 74 octets of content. Splits are backed
 * off so a multi-byte UTF-8 sequence is never cut in half.
 */
export function foldIcsLine(line: string): string {
  const bytes = encoder.encode(line);
  if (bytes.length <= 75) return line;

  const parts: string[] = [];
  let offset = 0;
  let first = true;
  while (offset < bytes.length) {
    // First segment: 75 octets. Continuations: 74 content octets (the leading
    // space is the 75th).
    let take = Math.min(first ? 75 : 74, bytes.length - offset);
    // Back off to a UTF-8 boundary: a continuation byte looks like 10xxxxxx.
    while (take > 0 && offset + take < bytes.length && (bytes[offset + take]! & 0xc0) === 0x80) {
      take -= 1;
    }
    parts.push(decoder.decode(bytes.subarray(offset, offset + take)));
    offset += take;
    first = false;
  }
  return parts.join('\r\n ');
}

/** Format an instant as an iCalendar UTC date-time: `YYYYMMDDTHHMMSSZ`. */
export function formatIcsUtc(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}

/** Stable per-booking UID so calendar apps update rather than duplicate. */
export function icsUidForOrderItem(orderItemId: string): string {
  return `${orderItemId}@marina-booking`;
}

/** Event end = start + rate duration. Non-positive durations fall back to 1h. */
export function eventEnd(start: Date, durationMinutes: number): Date {
  const minutes = Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : 60;
  return new Date(start.getTime() + minutes * 60_000);
}

// ---------------------------------------------------------------------------
// Calendar assembly
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  /** Stable unique id — use icsUidForOrderItem(). */
  uid: string;
  start: Date;
  durationMinutes: number;
  summary: string;
  description?: string;
  location?: string;
  /** Absolute URL attached to the event (admin deep link). */
  url?: string;
  /** Emits STATUS:CANCELLED instead of STATUS:CONFIRMED. */
  cancelled?: boolean;
}

export interface CalendarOptions {
  /** X-WR-CALNAME — how the subscribed calendar is titled in Google/Apple. */
  calendarName: string;
  events: CalendarEvent[];
  /** DTSTAMP for every event; defaults to now. Injectable for deterministic tests. */
  now?: Date;
}

/** Serialize one VEVENT into (unfolded) content lines. */
function eventLines(event: CalendarEvent, dtstamp: string): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(event.uid)}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${formatIcsUtc(event.start)}`,
    `DTEND:${formatIcsUtc(eventEnd(event.start, event.durationMinutes))}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  // URL is a VALUE=URI property — not text-escaped, per RFC 5545 §3.8.4.6.
  if (event.url) lines.push(`URL:${event.url}`);
  lines.push(`STATUS:${event.cancelled ? 'CANCELLED' : 'CONFIRMED'}`);
  lines.push('END:VEVENT');
  return lines;
}

/**
 * Build a complete iCalendar document (CRLF line endings, folded at 75 octets).
 */
export function buildIcsCalendar(options: CalendarOptions): string {
  const dtstamp = formatIcsUtc(options.now ?? new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Marina Booking Platform//Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(options.calendarName)}`,
  ];
  for (const event of options.events) lines.push(...eventLines(event, dtstamp));
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Booking → event mapping (shared by the feed and the per-booking download)
// ---------------------------------------------------------------------------

/** The slice of an order item (with relations) the event mapper needs. */
export interface BookingEventSource {
  id: string;
  quantity: number;
  waiver_signed: boolean;
  status: string;
  activity: {
    name_external: string;
    location?: { name: string; address: string | null; city: string | null; state: string | null } | null;
  };
  rate: { duration_minutes: number };
  timeslot: { datetime: Date };
  order: {
    id: string;
    order_number: string;
    status: string;
    balance_due_cents: number;
    customer: { first_name: string; last_name: string; phone: string | null };
  };
}

export function formatCentsUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** `{activity} — {n} guests ({order number})` */
export function bookingSummary(item: BookingEventSource): string {
  const guests = `${item.quantity} guest${item.quantity === 1 ? '' : 's'}`;
  return `${item.activity.name_external} — ${guests} (${item.order.order_number})`;
}

/** Human location string from the activity's location, if any. */
export function bookingLocation(item: BookingEventSource): string | undefined {
  const loc = item.activity.location;
  if (!loc) return undefined;
  const parts = [loc.name, loc.address, [loc.city, loc.state].filter(Boolean).join(' ')].filter(
    (p): p is string => Boolean(p && p.trim()),
  );
  return parts.length ? parts.join(', ') : undefined;
}

/**
 * Map a booked order item to a feed CalendarEvent. `adminOrderUrl` is the deep
 * link into the operator app; pass undefined for surfaces (customer download)
 * that must not leak it.
 */
export function bookingToEvent(
  item: BookingEventSource,
  adminOrderUrl?: string,
): CalendarEvent {
  const customer = item.order.customer;
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim();
  const descriptionLines = [
    `Customer: ${name || 'Unknown'}`,
    customer.phone ? `Phone: ${customer.phone}` : null,
    `Party size: ${item.quantity}`,
    `Waiver: ${item.waiver_signed ? 'signed' : 'not signed'}`,
    `Balance due: ${formatCentsUsd(item.order.balance_due_cents)}`,
    adminOrderUrl ? `Order: ${adminOrderUrl}` : null,
  ].filter((l): l is string => Boolean(l));

  return {
    uid: icsUidForOrderItem(item.id),
    start: item.timeslot.datetime,
    durationMinutes: item.rate.duration_minutes,
    summary: bookingSummary(item),
    description: descriptionLines.join('\n'),
    location: bookingLocation(item),
    url: adminOrderUrl,
    cancelled: item.status === 'CANCELLED' || item.order.status === 'CANCELLED',
  };
}
