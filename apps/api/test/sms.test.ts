/**
 * Unit tests for the SMS service's pure logic — phone normalization and the
 * no-op guards that keep sends from ever throwing. These need NO database or
 * Twilio config (they exercise paths that return before any network/DB access),
 * so they run anywhere alongside the rate-limiter unit tests.
 */
import { describe, it, expect } from 'vitest';
import { toE164, sendSms } from '../src/services/sms.js';

describe('toE164 phone normalization', () => {
  it('prefixes +1 for a bare 10-digit US number', () => {
    expect(toE164('7075551234')).toBe('+17075551234');
    expect(toE164('(707) 555-1234')).toBe('+17075551234');
    expect(toE164('707.555.1234')).toBe('+17075551234');
  });

  it('handles an 11-digit number with a leading 1', () => {
    expect(toE164('17075551234')).toBe('+17075551234');
    expect(toE164('1 (707) 555-1234')).toBe('+17075551234');
  });

  it('keeps an already-E.164 number', () => {
    expect(toE164('+447911123456')).toBe('+447911123456');
    expect(toE164('+1 707 555 1234')).toBe('+17075551234');
  });

  it('returns null for junk / too-short / empty input', () => {
    expect(toE164('')).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
    expect(toE164('12345')).toBeNull();
    expect(toE164('not a phone')).toBeNull();
  });
});

describe('sendSms guards (never throw, no provider needed)', () => {
  it('no-ops with a clear reason when the phone is missing/invalid', async () => {
    const noPhone = await sendSms('op_test', null, 'hi');
    expect(noPhone.sent).toBe(false);
    expect(noPhone.skippedReason).toBe('no valid phone number');

    const badPhone = await sendSms('op_test', 'nope', 'hi');
    expect(badPhone.sent).toBe(false);
    expect(badPhone.skippedReason).toBe('no valid phone number');
  });

  // The booking-cancelled text is just another kind through the same choke point,
  // so it inherits the never-throw / no-valid-phone guard verbatim: a cancel with a
  // missing or junk phone must no-op, never block or fail the cancellation.
  it('no-ops the booking_cancelled kind on a missing/invalid phone', async () => {
    const missing = await sendSms('op_test', null, 'cancelled', 'booking_cancelled');
    expect(missing.sent).toBe(false);
    expect(missing.skippedReason).toBe('no valid phone number');

    const junk = await sendSms('op_test', '12345', 'cancelled', 'booking_cancelled');
    expect(junk.sent).toBe(false);
    expect(junk.skippedReason).toBe('no valid phone number');
  });
});
