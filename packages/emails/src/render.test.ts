/**
 * Render-safety tests for every template in the package.
 *
 * These exist because a NUL byte (U+0000) in the rendered HTML of StaffNewBooking
 * silently killed staff "new booking" alerts for the life of the project: Postgres
 * refuses NUL in a text column, so the sandbox capture INSERT failed with
 * `invalid byte sequence for encoding "UTF8"` and the notification was dropped.
 * Nothing looked broken because the guest's confirmation rendered clean.
 *
 * The NUL comes from react-dom 18's Node stream writer flushing the unfilled tail
 * of its 2048-byte encode buffer (see sanitize.ts), so whether a given email
 * carries one is decided by the byte length of the document — i.e. by the props.
 * That is why the checks below are not one render per template but a sweep across
 * lengths: a single fixed prop set can sit safely on one side of a buffer boundary
 * forever while real bookings sit on the other.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@react-email/components';
import type * as React from 'react';
import {
  BookingConfirmation,
  BookingReminder,
  RefundReceipt,
  StaffNewBooking,
  WaiverRequest,
  renderEmail,
  renderEmailText,
  findUnsafeControlChars,
  formatCodePoint,
  stripUnsafeControlChars,
} from './index.js';

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

/** Fail with the code point, the offset, and the surrounding text — not just "false". */
function expectNoUnsafeChars(label: string, value: string): void {
  const found = findUnsafeControlChars(value);
  if (found.length === 0) return;

  const first = found[0]!;
  const excerpt = JSON.stringify(value.slice(Math.max(0, first.index - 60), first.index + 60));
  expect.fail(
    `${label} contains ${found.length} unsafe control character(s): ` +
      `${[...new Set(found.map((c) => formatCodePoint(c.codePoint)))].join(', ')} ` +
      `— first at offset ${first.index}, near ${excerpt}`,
  );
}

// ---------------------------------------------------------------------------
// Realistic props (the shapes apps/api/src/services/notifications.ts actually passes)
// ---------------------------------------------------------------------------

const BRAND = { brandName: 'Lake Sonoma Marina', brandColor: '#0ea5e9' } as const;

/** A real seeded activity name — this exact one reproduces the bug every render. */
const SEEDED_ACTIVITY = '10 Person Pontoon Rental';

const STAFF_PROPS = {
  ...BRAND,
  orderNumber: 'LSRA-2606-0041',
  activityName: SEEDED_ACTIVITY,
  dateLabel: 'Thursday, June 4, 2026',
  timeLabel: '9:00 AM',
  partySize: 6,
  locationLabel: 'Lake Sonoma Marina',
  customerName: 'Dana Whitfield',
  customerEmail: 'dana.whitfield@example.com',
  customerPhone: '(707) 555-0134',
  totalCents: 48_500,
  // notifications.ts derives these two, and an isolated render that omits them
  // shifts every downstream byte — which is exactly what hid the bug.
  channelLabel: 'Online',
  manageUrl: 'http://localhost:3002/lake-sonoma/admin/orders/kx8p2m4q1r7t9v3w',
} satisfies Parameters<typeof StaffNewBooking>[0];

const CONFIRMATION_PROPS = {
  ...BRAND,
  orderNumber: 'LSRA-2606-0041',
  customerName: 'Dana',
  activityName: SEEDED_ACTIVITY,
  dateLabel: 'Thursday, June 4, 2026',
  timeLabel: '9:00 AM',
  partySize: 6,
  locationLabel: 'Lake Sonoma Marina',
  lineItems: [
    { label: 'Subtotal', amountCents: 42_000 },
    { label: 'Discount', amountCents: -2_100 },
    { label: 'Tax', amountCents: 3_465 },
    { label: 'Processing fee', amountCents: 1_235 },
  ],
  totalCents: 48_500,
  cancellationPolicy:
    'Free reschedule or cancellation is available up to the window shown in your ' +
    'booking details. Within that window, fees may apply.',
} satisfies Parameters<typeof BookingConfirmation>[0];

const REMINDER_PROPS = {
  ...BRAND,
  orderNumber: 'LSRA-2606-0041',
  customerName: 'Dana',
  activityName: SEEDED_ACTIVITY,
  dateLabel: 'Thursday, June 4, 2026',
  timeLabel: '9:00 AM',
  checkInTimeLabel: '8:30 AM',
  locationLabel: 'Lake Sonoma Marina',
  whatToBring: [
    'A valid photo ID for the reservation holder',
    'Your confirmation number or this email',
    'Sun protection (hat, sunscreen, sunglasses)',
  ],
} satisfies Parameters<typeof BookingReminder>[0];

const REFUND_PROPS = {
  ...BRAND,
  orderNumber: 'LSRA-2606-0041',
  customerName: 'Dana',
  refundedCents: 12_500,
  reason: 'Weather cancellation',
  originalTotalCents: 48_500,
  remainingBalanceCents: 36_000,
  processedDateLabel: 'June 2, 2026',
  paymentMethodLabel: 'Visa ending 4242',
} satisfies Parameters<typeof RefundReceipt>[0];

const WAIVER_PROPS = {
  ...BRAND,
  customerName: 'Dana',
  activityName: SEEDED_ACTIVITY,
  dateLabel: 'Thursday, June 4, 2026',
  orderNumber: 'LSRA-2606-0041',
  waiverUrl: 'http://localhost:3000/lake-sonoma/waiver/kx8p2m4q1r7t9v3w',
  deadlineLabel: 'before 9:00 AM on June 4',
} satisfies Parameters<typeof WaiverRequest>[0];

// Awkward but legal inputs an operator can actually produce.
const LONG_NAME =
  'Premium Double Decker 12 Person Pontoon Boat Rental with Waterslide and Sun Deck';
const UNICODE_NAME = 'Croisiere sur le lac — ボートツアー 🚤🌅';
const RTL_NAME = 'تأجير قارب';

/**
 * Every template under every awkward prop shape. `make` takes a filler string that
 * the sweep grows one character at a time to walk the render across the encoder's
 * buffer boundaries.
 */
const CASES: Array<{ name: string; make: (filler: string) => React.ReactElement }> = [
  {
    name: 'StaffNewBooking (as notifications.ts sends it)',
    make: (f) => StaffNewBooking({ ...STAFF_PROPS, activityName: SEEDED_ACTIVITY + f }),
  },
  {
    name: 'StaffNewBooking (no staffName, channel, location or phone)',
    make: (f) =>
      StaffNewBooking({
        ...BRAND,
        orderNumber: 'LSRA-2606-0041',
        activityName: SEEDED_ACTIVITY + f,
        dateLabel: 'Thursday, June 4, 2026',
        timeLabel: '9:00 AM',
        partySize: 1,
        customerName: 'Dana Whitfield',
        customerEmail: 'dana@example.com',
        totalCents: 0,
        manageUrl: 'http://localhost:3002/lake-sonoma/admin/orders/kx8p2m4q1r7t9v3w',
      }),
  },
  {
    name: 'StaffNewBooking (staffName, long activity, logo)',
    make: (f) =>
      StaffNewBooking({
        ...STAFF_PROPS,
        logoUrl: 'http://localhost:3000/brand/lake-sonoma/logo-light.png',
        staffName: 'Marcus',
        activityName: LONG_NAME + f,
        customerName: 'Bartholomew Featherstonehaugh-Vandermeulen III',
      }),
  },
  {
    name: 'StaffNewBooking (unicode activity + customer)',
    make: (f) =>
      StaffNewBooking({
        ...STAFF_PROPS,
        activityName: UNICODE_NAME + f,
        customerName: RTL_NAME,
        locationLabel: 'Quâi n° 3 — Dôme',
      }),
  },
  {
    name: 'BookingConfirmation (full price breakdown)',
    make: (f) => BookingConfirmation({ ...CONFIRMATION_PROPS, activityName: SEEDED_ACTIVITY + f }),
  },
  {
    name: 'BookingConfirmation (empty line items, no location)',
    make: (f) =>
      BookingConfirmation({
        ...CONFIRMATION_PROPS,
        activityName: SEEDED_ACTIVITY + f,
        lineItems: [],
        locationLabel: undefined,
        partySize: 1,
        totalCents: 0,
      }),
  },
  {
    name: 'BookingConfirmation (unicode, long policy)',
    make: (f) =>
      BookingConfirmation({
        ...CONFIRMATION_PROPS,
        activityName: UNICODE_NAME + f,
        customerName: RTL_NAME,
        cancellationPolicy: CONFIRMATION_PROPS.cancellationPolicy.repeat(3),
      }),
  },
  {
    name: 'BookingConfirmation (reserve now, pay at the marina)',
    make: (f) =>
      BookingConfirmation({
        ...CONFIRMATION_PROPS,
        activityName: SEEDED_ACTIVITY + f,
        // Nothing paid online; the full total is owed on arrival.
        balanceDueCents: CONFIRMATION_PROPS.totalCents,
      }),
  },
  {
    name: 'BookingReminder (full)',
    make: (f) => BookingReminder({ ...REMINDER_PROPS, activityName: SEEDED_ACTIVITY + f }),
  },
  {
    name: 'BookingReminder (empty what-to-bring, no location)',
    make: (f) =>
      BookingReminder({
        ...REMINDER_PROPS,
        activityName: SEEDED_ACTIVITY + f,
        whatToBring: [],
        locationLabel: undefined,
      }),
  },
  {
    name: 'RefundReceipt (full)',
    make: (f) => RefundReceipt({ ...REFUND_PROPS, reason: `Weather cancellation${f}` }),
  },
  {
    name: 'RefundReceipt (no processed date or payment method, zero balance)',
    make: (f) =>
      RefundReceipt({
        ...REFUND_PROPS,
        reason: `Weather cancellation${f}`,
        processedDateLabel: undefined,
        paymentMethodLabel: undefined,
        remainingBalanceCents: 0,
      }),
  },
  {
    name: 'WaiverRequest (with deadline)',
    make: (f) => WaiverRequest({ ...WAIVER_PROPS, activityName: SEEDED_ACTIVITY + f }),
  },
  {
    name: 'WaiverRequest (no deadline, unicode)',
    make: (f) =>
      WaiverRequest({
        ...WAIVER_PROPS,
        activityName: UNICODE_NAME + f,
        customerName: RTL_NAME,
        deadlineLabel: undefined,
      }),
  },
];

/**
 * How many one-character steps each sweep walks. Each added character to the inbox
 * preview line removes a seven-character run of <Preview> padding, so ~40 steps is
 * enough to move a 2048-byte buffer boundary clean through the padding block and
 * out the far side.
 */
const SWEEP_STEPS = 40;

// ---------------------------------------------------------------------------

describe('render guard', () => {
  beforeEach(() => {
    // The guard warns on every strip. That is the point in production and noise here.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(CASES)('$name', ({ name, make }) => {
    it('renders HTML free of unsafe control characters at every byte alignment', async () => {
      for (let i = 0; i < SWEEP_STEPS; i++) {
        const html = await renderEmail(make('x'.repeat(i)));
        expect(html.length).toBeGreaterThan(0);
        expectNoUnsafeChars(`${name} HTML (+${i} chars)`, html);
      }
    });

    it('renders plain text free of unsafe control characters', async () => {
      const text = await renderEmailText(make(''));
      expect(text.length).toBeGreaterThan(0);
      expectNoUnsafeChars(`${name} text`, text);
    });
  });

  it('cleans the exact StaffNewBooking render that dropped every staff alert', async () => {
    const element = () => StaffNewBooking(STAFF_PROPS);

    // Raw react-email render, i.e. what the product shipped before the guard.
    const raw = await render(element());
    const rawFindings = findUnsafeControlChars(raw);

    const guarded = await renderEmail(element());
    expectNoUnsafeChars('guarded StaffNewBooking HTML', guarded);
    // Only the corruption is removed; the email itself survives intact.
    expect(guarded).toContain('New booking received');
    expect(guarded).toContain(STAFF_PROPS.orderNumber);
    expect(guarded.length).toBe(raw.length - rawFindings.length);

    if (rawFindings.length > 0) {
      // The upstream defect is still present, so prove the guard is what saves us.
      expect(rawFindings.every((c) => c.codePoint === 0x00)).toBe(true);
      expect(console.warn).toHaveBeenCalled();
    }
  });

  it('leaves a clean render byte-for-byte untouched and does not warn', async () => {
    const element = () => RefundReceipt(REFUND_PROPS);
    const raw = await render(element());
    expect(findUnsafeControlChars(raw)).toHaveLength(0);
    expect(await renderEmail(element())).toBe(raw);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('states the amount due at the marina in a reserve-now confirmation', async () => {
    const html = await renderEmail(
      BookingConfirmation({ ...CONFIRMATION_PROPS, balanceDueCents: CONFIRMATION_PROPS.totalCents }),
    );
    const text = await renderEmailText(
      BookingConfirmation({ ...CONFIRMATION_PROPS, balanceDueCents: CONFIRMATION_PROPS.totalCents }),
    );
    // The customer is told what is owed on arrival, and what to bring.
    expect(html).toContain('Due at the marina');
    expect(html).toContain('$485.00'); // CONFIRMATION_PROPS.totalCents = 48_500
    expect(html).toContain('Pay when you arrive');
    expect(text).toContain('Due at the marina');
    // Never leaks dev/test/fake/simulated wording to the guest.
    expect(html.toLowerCase()).not.toMatch(/\b(fake|simulated|sandbox|dev mode|test payment)\b/);
  });

  it('does not mention a marina balance in an ordinary paid confirmation', async () => {
    const html = await renderEmail(BookingConfirmation(CONFIRMATION_PROPS));
    expect(html).not.toContain('Due at the marina');
  });
});

describe('stripUnsafeControlChars', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes NUL, the byte Postgres refuses in a text column', () => {
    expect(stripUnsafeControlChars('New\u0000 booking')).toBe('New booking');
  });

  it('removes the other control characters a mail transport mangles', () => {
    const dirty = 'a\u0001b\u0008c\u000Bd\u000Ee\u001Af\u007Fg\u0085h\u009Fi';
    expect(stripUnsafeControlChars(dirty)).toBe('abcdefghi');
  });

  it('preserves tab, newline and carriage return', () => {
    const structural = 'line one\r\n\tline two\n';
    expect(stripUnsafeControlChars(structural)).toBe(structural);
  });

  it('preserves the zero-width characters <Preview> pads with', () => {
    const padding = '\u00A0\u200C\u200B\u200D\u200E\u200F\uFEFF'.repeat(20);
    expect(stripUnsafeControlChars(padding)).toBe(padding);
  });

  it('preserves astral characters instead of splitting their surrogate pair', () => {
    const emoji = 'Pontoon 🚤 rental \u{1D11E}';
    expect(stripUnsafeControlChars(emoji)).toBe(emoji);
  });

  it('removes a lone surrogate, which has no UTF-8 encoding at all', () => {
    expect(stripUnsafeControlChars('Dana \ud83d Whitfield')).toBe('Dana  Whitfield');
    expect(stripUnsafeControlChars('Dana \udea4 Whitfield')).toBe('Dana  Whitfield');
  });

  it('reports what it stripped rather than scrubbing silently', () => {
    stripUnsafeControlChars('New\u0000 booking', 'renderEmail(StaffNewBooking)');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('renderEmail(StaffNewBooking)'),
    );
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('U+0000'));
  });

  it('is not confused by regex state across calls', () => {
    const dirty = 'a\u0000b\u0000c';
    expect(stripUnsafeControlChars(dirty)).toBe('abc');
    expect(stripUnsafeControlChars(dirty)).toBe('abc');
    expect(findUnsafeControlChars(dirty)).toHaveLength(2);
    expect(findUnsafeControlChars(dirty)).toHaveLength(2);
  });
});
