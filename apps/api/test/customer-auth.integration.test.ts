/**
 * Customer auth (email-OTP) — live integration test against the seeded LSRA tenant on
 * Neon. Verifies the passwordless login mechanism end to end via HTTP, plus its
 * integration with the customer self-service reschedule endpoint:
 *   - request a code: with no Resend key the response surfaces a 6-digit devCode and
 *     persists a CustomerOtp row;
 *   - a wrong code is rejected (401) and bumps the attempt counter;
 *   - the correct code returns a signed session token, then is single-use (a second
 *     verify with the consumed code 400s);
 *   - the issued token authenticates a self-reschedule with NO body email (the token's
 *     email is the identity), and a token for a different email cannot move the booking.
 *
 * Skips without DATABASE_URL. Email is unconfigured in tests, so requestLoginCode
 * returns the devCode. Creates its own customer/booking/slots and cleans up.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { app } from '../src/app.js';
import { verifyCustomerToken } from '../src/services/customer-auth.js';
import { createBooking } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const EMAIL = 'custauth-itest@example.com';
const BOOK_EMAIL = 'custauth-book-itest@example.com';
const OTHER_EMAIL = 'custauth-other-itest@example.com';
const DAY = 24 * 60 * 60 * 1000;
const jsonHeaders = { 'x-operator-slug': SLUG, 'content-type': 'application/json' };

let activityId = '';
let rateId = '';
let qty = 1;
let maxCap = 10;
let slotA = '';
let slotB = '';
let bookOrderNumber = '';
let bookOrderId = '';

async function requestCode(email: string): Promise<string> {
  const res = await app.request('/api/auth/customer/request', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sent: boolean; devCode?: string };
  expect(body.sent).toBe(false); // no Resend key in tests
  expect(body.devCode).toMatch(/^\d{6}$/);
  return body.devCode!;
}

async function tokenFor(email: string): Promise<string> {
  const code = await requestCode(email);
  const res = await app.request('/api/auth/customer/verify', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ email, code }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  return body.token;
}

// Force transactional email OFF for this suite so requestLoginCode returns the
// devCode (the only way to complete the flow headlessly) and makes no external
// Resend calls. Saved/restored around the suite so it can't leak to other files.
let savedResendKey: string | undefined;

describe.skipIf(!HAS_DB)('customer auth (email-OTP, live HTTP vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    savedResendKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;

    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true },
      },
      select: {
        id: true,
        activity_id: true,
        activity: { select: { min_participants: true, max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');
    activityId = rate.activity_id;
    rateId = rate.id;
    qty = rate.activity.min_participants;
    maxCap = rate.activity.max_participants;

    await adminPrisma.customer.deleteMany({
      where: { operator_id: OP, email: { in: [EMAIL, BOOK_EMAIL, OTHER_EMAIL] } },
    });
    await adminPrisma.customerOtp.deleteMany({
      where: { operator_id: OP, email: { in: [EMAIL, BOOK_EMAIL, OTHER_EMAIL] } },
    });

    const mk = async (offsetMs: number) =>
      (
        await forOperator(OP).timeslot.create({
          data: {
            operator_id: OP,
            activity_id: activityId,
            datetime: new Date(Date.now() + offsetMs),
            capacity_total: maxCap,
            capacity_booked: 0,
            status: 'AVAILABLE',
          },
          select: { id: true },
        })
      ).id;
    slotA = await mk(50 * DAY);
    slotB = await mk(51 * DAY);

    const order = await createBooking(
      OP,
      {
        activityId,
        rateId,
        timeslotId: slotA,
        quantity: qty,
        customer: { first_name: 'Cust', last_name: 'Auth', email: BOOK_EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    bookOrderId = order.id;
    bookOrderNumber = order.order_number;
  });

  afterAll(async () => {
    if (bookOrderId) await adminPrisma.order.deleteMany({ where: { id: bookOrderId } });
    await adminPrisma.timeslot.deleteMany({ where: { id: { in: [slotA, slotB].filter(Boolean) } } });
    await adminPrisma.customer.deleteMany({
      where: { operator_id: OP, email: { in: [EMAIL, BOOK_EMAIL, OTHER_EMAIL] } },
    });
    await adminPrisma.customerOtp.deleteMany({
      where: { operator_id: OP, email: { in: [EMAIL, BOOK_EMAIL, OTHER_EMAIL] } },
    });
    if (savedResendKey !== undefined) process.env.RESEND_API_KEY = savedResendKey;
    await adminPrisma.$disconnect();
  });

  it('request returns a devCode (no Resend key) and persists an OTP row', async () => {
    const code = await requestCode(EMAIL);
    const otp = await adminPrisma.customerOtp.findFirst({
      where: { operator_id: OP, email: EMAIL, consumed_at: null },
      orderBy: { created_at: 'desc' },
    });
    expect(otp).toBeTruthy();
    expect(otp!.code_hash).not.toBe(code); // stored hashed, never raw
  });

  it('rejects a wrong code (401) and increments the attempt counter', async () => {
    await requestCode(EMAIL); // fresh code
    const res = await app.request('/api/auth/customer/verify', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ email: EMAIL, code: '000001' }),
    });
    // The crypto-random real code is essentially never 000001; treat a match as flake-proof.
    expect([401]).toContain(res.status);
    const otp = await adminPrisma.customerOtp.findFirst({
      where: { operator_id: OP, email: EMAIL, consumed_at: null },
      orderBy: { created_at: 'desc' },
    });
    expect(otp!.attempts).toBeGreaterThanOrEqual(1);
  });

  it('accepts the correct code, returns a verifiable token, and is single-use', async () => {
    const code = await requestCode(EMAIL);
    const res = await app.request('/api/auth/customer/verify', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ email: EMAIL, code }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresInSeconds: number };
    expect(typeof body.token).toBe('string');

    // The token verifies and carries the right identity, scoped to the operator.
    const identity = await verifyCustomerToken(body.token, OP);
    expect(identity).toBeTruthy();
    expect(identity!.email).toBe(EMAIL);
    // ...but not under a different operator id.
    expect(await verifyCustomerToken(body.token, 'some-other-op')).toBeNull();

    // The code is now consumed — a second verify is refused.
    const again = await app.request('/api/auth/customer/verify', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ email: EMAIL, code }),
    });
    expect(again.status).toBe(400);
  });

  it('a token authenticates self-reschedule with no body email', async () => {
    const token = await tokenFor(BOOK_EMAIL);
    const res = await app.request(`/api/orders/${bookOrderNumber}/self-reschedule`, {
      method: 'POST',
      headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
      body: JSON.stringify({ timeslotId: slotB }), // no email — identity from the token
    });
    expect(res.status).toBe(200);
    const item = await adminPrisma.orderItem.findFirst({ where: { order_id: bookOrderId } });
    expect(item!.timeslot_id).toBe(slotB);
  });

  it("a token for a different email cannot reschedule someone else's booking", async () => {
    const token = await tokenFor(OTHER_EMAIL);
    const res = await app.request(`/api/orders/${bookOrderNumber}/self-reschedule`, {
      method: 'POST',
      headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
      body: JSON.stringify({ timeslotId: slotA }),
    });
    expect(res.status).toBe(404); // identity mismatch — same response as "not found"
    const item = await adminPrisma.orderItem.findFirst({ where: { order_id: bookOrderId } });
    expect(item!.timeslot_id).toBe(slotB); // unchanged
  });
});
