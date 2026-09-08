/**
 * Unit tests for the pure iCalendar builder (services/calendar-feed.ts):
 * RFC 5545 text escaping, line folding at 75 OCTETS (UTF-8 safe), UTC date-time
 * formatting, stable UIDs, duration math, and full-document assembly. No DB.
 */
import { describe, it, expect } from 'vitest';
import {
  escapeIcsText,
  foldIcsLine,
  formatIcsUtc,
  icsUidForOrderItem,
  eventEnd,
  buildIcsCalendar,
  bookingToEvent,
  bookingSummary,
  bookingLocation,
  formatCentsUsd,
  type BookingEventSource,
} from '../src/services/calendar-feed.js';

describe('escapeIcsText', () => {
  it('escapes backslash, semicolon, comma, and newlines', () => {
    expect(escapeIcsText('a\\b;c,d')).toBe('a\\\\b\\;c\\,d');
    expect(escapeIcsText('line1\nline2\r\nline3\rline4')).toBe('line1\\nline2\\nline3\\nline4');
  });

  it('escapes backslash BEFORE the others (no double-escaping)', () => {
    // If ; were escaped first, the \ added for it would be re-escaped.
    expect(escapeIcsText(';')).toBe('\\;');
    expect(escapeIcsText('\\;')).toBe('\\\\\\;');
  });

  it('passes plain text through unchanged', () => {
    expect(escapeIcsText('Pontoon Boat 4hr (LS-1234)')).toBe('Pontoon Boat 4hr (LS-1234)');
  });
});

describe('foldIcsLine', () => {
  it('leaves lines of 75 octets or fewer alone', () => {
    const line = 'X'.repeat(75);
    expect(foldIcsLine(line)).toBe(line);
  });

  it('folds at 75 octets with space-prefixed continuations', () => {
    const line = 'SUMMARY:' + 'A'.repeat(100);
    const folded = foldIcsLine(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBe(2);
    expect(Buffer.byteLength(parts[0]!)).toBe(75);
    expect(parts[1]!.startsWith(' ')).toBe(true);
    // Unfolding (strip CRLF + one space) restores the original exactly.
    expect(folded.replace(/\r\n /g, '')).toBe(line);
    // Every physical line (incl. the continuation space) is <= 75 octets.
    for (const part of parts) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
  });

  it('folds long lines into multiple continuations', () => {
    const line = 'DESCRIPTION:' + 'B'.repeat(300);
    const parts = foldIcsLine(line).split('\r\n');
    expect(parts.length).toBeGreaterThan(3);
    for (const part of parts) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
    expect(foldIcsLine(line).replace(/\r\n /g, '')).toBe(line);
  });

  it('never splits a multi-byte UTF-8 character', () => {
    // é is 2 octets in UTF-8; a run of them guarantees a boundary lands mid-char
    // for a naive byte slicer.
    const line = 'SUMMARY:' + 'é'.repeat(80);
    const folded = foldIcsLine(line);
    for (const part of folded.split('\r\n')) {
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
      // A split sequence would decode to U+FFFD replacement characters.
      expect(part.includes('�')).toBe(false);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });
});

describe('formatIcsUtc', () => {
  it('formats an instant as YYYYMMDDTHHMMSSZ', () => {
    expect(formatIcsUtc(new Date('2026-07-04T15:30:00Z'))).toBe('20260704T153000Z');
  });

  it('zero-pads all fields', () => {
    expect(formatIcsUtc(new Date('2026-01-02T03:04:05Z'))).toBe('20260102T030405Z');
  });
});

describe('icsUidForOrderItem', () => {
  it('is stable and derived from the order item id', () => {
    expect(icsUidForOrderItem('abc123')).toBe('abc123@marina-booking');
    expect(icsUidForOrderItem('abc123')).toBe(icsUidForOrderItem('abc123'));
  });
});

describe('eventEnd', () => {
  it('adds the rate duration to the start', () => {
    const start = new Date('2026-07-04T15:00:00Z');
    expect(formatIcsUtc(eventEnd(start, 240))).toBe('20260704T190000Z');
  });

  it('falls back to 60 minutes for zero/negative/NaN durations', () => {
    const start = new Date('2026-07-04T15:00:00Z');
    for (const bad of [0, -30, Number.NaN]) {
      expect(formatIcsUtc(eventEnd(start, bad))).toBe('20260704T160000Z');
    }
  });
});

const SOURCE: BookingEventSource = {
  id: 'item_1',
  quantity: 6,
  waiver_signed: true,
  status: 'UPCOMING',
  activity: {
    name_external: 'Pontoon Boat, 25ft',
    location: { name: 'Lake Sonoma Marina', address: '100 Marina Rd', city: 'Geyserville', state: 'CA' },
  },
  rate: { duration_minutes: 240 },
  timeslot: { datetime: new Date('2026-07-04T17:00:00Z') },
  order: {
    id: 'order_1',
    order_number: 'LS-260704-001',
    status: 'UPCOMING',
    balance_due_cents: 14202,
    customer: { first_name: 'Ada', last_name: 'Lovelace', phone: '+17075550123' },
  },
};

describe('booking → event mapping', () => {
  it('builds the summary as "{activity} — {n} guests ({order number})"', () => {
    expect(bookingSummary(SOURCE)).toBe('Pontoon Boat, 25ft — 6 guests (LS-260704-001)');
    expect(bookingSummary({ ...SOURCE, quantity: 1 })).toBe(
      'Pontoon Boat, 25ft — 1 guest (LS-260704-001)',
    );
  });

  it('formats cents as USD', () => {
    expect(formatCentsUsd(14202)).toBe('$142.02');
    expect(formatCentsUsd(0)).toBe('$0.00');
  });

  it('joins location name/address/city into one string; undefined without one', () => {
    expect(bookingLocation(SOURCE)).toBe('Lake Sonoma Marina, 100 Marina Rd, Geyserville CA');
    expect(
      bookingLocation({ ...SOURCE, activity: { name_external: 'X', location: null } }),
    ).toBeUndefined();
  });

  it('carries customer, waiver, balance, and the admin link into the description', () => {
    const event = bookingToEvent(SOURCE, 'http://localhost:3002/orders/order_1');
    expect(event.uid).toBe('item_1@marina-booking');
    expect(event.description).toBe(
      [
        'Customer: Ada Lovelace',
        'Phone: +17075550123',
        'Party size: 6',
        'Waiver: signed',
        'Balance due: $142.02',
        'Order: http://localhost:3002/orders/order_1',
      ].join('\n'),
    );
    expect(event.url).toBe('http://localhost:3002/orders/order_1');
    expect(event.cancelled).toBe(false);
  });

  it('marks the event cancelled when the item OR the order is cancelled', () => {
    expect(bookingToEvent({ ...SOURCE, status: 'CANCELLED' }).cancelled).toBe(true);
    expect(
      bookingToEvent({ ...SOURCE, order: { ...SOURCE.order, status: 'CANCELLED' } }).cancelled,
    ).toBe(true);
  });

  it('omits admin link + phone lines when not provided', () => {
    const event = bookingToEvent({
      ...SOURCE,
      order: { ...SOURCE.order, customer: { ...SOURCE.order.customer, phone: null } },
    });
    expect(event.url).toBeUndefined();
    expect(event.description).not.toContain('Phone:');
    expect(event.description).not.toContain('Order:');
  });
});

describe('buildIcsCalendar', () => {
  const NOW = new Date('2026-06-01T00:00:00Z');

  it('produces a valid VCALENDAR wrapping one VEVENT with CRLF endings', () => {
    const ics = buildIcsCalendar({
      calendarName: 'Lake Sonoma — Bookings',
      events: [bookingToEvent(SOURCE, 'http://localhost:3002/orders/order_1')],
      now: NOW,
    });

    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('METHOD:PUBLISH');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
    expect(ics).toContain('UID:item_1@marina-booking');
    expect(ics).toContain('DTSTAMP:20260601T000000Z');
    expect(ics).toContain('DTSTART:20260704T170000Z');
    // 17:00 + 240min = 21:00 UTC — duration math end to end.
    expect(ics).toContain('DTEND:20260704T210000Z');
    expect(ics).toContain('STATUS:CONFIRMED');
    // The comma in the activity name is escaped in SUMMARY.
    expect(ics).toContain('SUMMARY:Pontoon Boat\\, 25ft — 6 guests (LS-260704-001)');
    // Newlines in the description became literal \n (unfold before asserting —
    // DESCRIPTION is longer than 75 octets so it is folded).
    expect(ics.replace(/\r\n /g, '')).toContain('Customer: Ada Lovelace\\nPhone: +17075550123');
    // No stray bare LFs: every line break is CRLF.
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('folds every physical line to 75 octets or fewer', () => {
    const ics = buildIcsCalendar({
      calendarName: 'A very long calendar name '.repeat(8),
      events: [bookingToEvent(SOURCE, 'http://localhost:3002/orders/order_1')],
      now: NOW,
    });
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    }
  });

  it('emits STATUS:CANCELLED for cancelled events', () => {
    const ics = buildIcsCalendar({
      calendarName: 'Cal',
      events: [bookingToEvent({ ...SOURCE, status: 'CANCELLED' })],
      now: NOW,
    });
    expect(ics).toContain('STATUS:CANCELLED');
  });

  it('handles an empty feed (still a valid document)', () => {
    const ics = buildIcsCalendar({ calendarName: 'Empty', events: [], now: NOW });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});
