/**
 * Customer authentication — email OTP → stateless session (roadmap 0.7).
 *
 *   POST /api/auth/request-otp  { orderNumber, email }  → { challenge, devCode? }
 *   POST /api/auth/verify-otp   { challenge, code }      → { sessionToken }
 *
 * Replaces the old order#+email URL stub with a verified, HMAC-signed session token
 * the web app stores in an httpOnly cookie. STATELESS by design — see
 * lib/customer-session.ts for the token layout, security notes, and the documented
 * brute-force-rate-limiting follow-up.
 *
 * Tenant-scoped via `c.var.db` (RLS) exactly like orders.ts. Order existence is NOT
 * leaked: a mismatched orderNumber/email still returns a (decoy) challenge of the
 * same shape, so request-otp can't be used to enumerate order numbers.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../context.js';
import {
  createChallenge,
  createDecoyChallenge,
  createSessionToken,
  generateOtpCode,
  normalizeEmail,
  verifyChallenge,
} from '../lib/customer-session.js';
import { sendCustomerOtp } from '../services/notifications.js';

export const auth = new Hono<Env>();

const IS_DEV = process.env.NODE_ENV !== 'production';

// --- POST /request-otp ------------------------------------------------------

const requestOtpSchema = z.object({
  orderNumber: z.string().trim().min(1, 'orderNumber is required'),
  email: z.string().trim().toLowerCase().email('A valid email is required'),
});

auth.post('/request-otp', async (c) => {
  const parsed = requestOtpSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  const orderNumber = parsed.data.orderNumber.toUpperCase();
  const email = normalizeEmail(parsed.data.email);

  // RLS-scoped lookup — verify the order exists AND its customer email matches.
  const found = await c.var.db.order.findFirst({
    where: { order_number: orderNumber },
    select: { customer: { select: { email: true } } },
  });
  const matches = Boolean(found && found.customer.email.toLowerCase() === email);

  if (!matches) {
    // Don't leak whether the order exists: return a decoy challenge of the same
    // shape. It carries a code the caller never learns, so it can never verify.
    return c.json({ challenge: createDecoyChallenge({ orderNumber, email }) });
  }

  const code = generateOtpCode();
  const challenge = createChallenge({ orderNumber, email, code });

  // Best-effort email (no-ops without RESEND_API_KEY). Never blocks/throws.
  const result = await sendCustomerOtp({ operatorId: c.var.operatorId, email, code });
  if (!result.sent) {
    // Dev/test convenience: surface the code so the flow is testable without a
    // real email provider. Guarded so it NEVER ships in production responses.
    console.log(`[auth] OTP for ${orderNumber} <${email}>: ${code}`);
  }

  return c.json({
    challenge,
    ...(IS_DEV ? { devCode: code } : {}),
  });
});

// --- POST /verify-otp -------------------------------------------------------

const verifyOtpSchema = z.object({
  challenge: z.string().min(1, 'challenge is required'),
  code: z.string().trim().min(1, 'code is required'),
});

auth.post('/verify-otp', async (c) => {
  const parsed = verifyOtpSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  const result = verifyChallenge(parsed.data.challenge, parsed.data.code);
  if (!result.ok) {
    // Generic message — don't distinguish wrong-code vs expired vs decoy.
    return c.json({ error: 'That code is incorrect or has expired.' }, 401);
  }

  // Resolve customerId for convenience (optional in the token). RLS-scoped.
  const order = await c.var.db.order.findFirst({
    where: { order_number: result.orderNumber },
    select: { customer: { select: { id: true, email: true } } },
  });
  // Defense in depth: re-confirm the order/email still matches at issue time.
  if (!order || order.customer.email.toLowerCase() !== result.email) {
    return c.json({ error: 'That code is incorrect or has expired.' }, 401);
  }

  const sessionToken = createSessionToken({
    orderNumber: result.orderNumber,
    email: result.email,
    customerId: order.customer.id,
  });

  return c.json({ sessionToken });
});
