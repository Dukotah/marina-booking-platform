/**
 * Customer auth — passwordless email-OTP login for guests (ROADMAP 0.7). A customer
 * requests a 6-digit code by email; we store only its sha256 hash + a short expiry,
 * and on a correct/unexpired/unconsumed match issue a short-lived **signed JWT**
 * (HS256, `hono/jwt`) that identifies the customer to self-service endpoints. This
 * is the customer analogue of the staff Clerk-bearer flow (middleware/auth.ts):
 * stateless bearer tokens, scoped to the resolved operator.
 *
 * Security posture:
 *  - the raw code is never persisted (only sha256); codes are single-use (consumed)
 *    and short-lived (10 min); a small attempt cap blocks brute force;
 *  - requesting a new code invalidates a tenant's prior unconsumed codes for that email;
 *  - the signing secret comes from CUSTOMER_AUTH_SECRET. In production it MUST be set
 *    (we fail closed); in dev/test a clearly-insecure fallback keeps things runnable;
 *  - email delivery is best-effort via the notifications service. When email isn't
 *    configured (no Resend key) AND we're not in production, the code is returned in
 *    the response (`devCode`) so local/headless flows can complete — the same
 *    graceful-degradation posture used for Clerk/Stripe.
 */
import { createHash, randomInt } from 'node:crypto';
import { sign, verify } from 'hono/jwt';
import { withTenant } from '@marina/database';
import { sendLoginCode } from './notifications.js';

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MAX_ATTEMPTS = 5;
const DEV_SECRET = 'dev-insecure-customer-auth-secret-change-me';

/** A typed, user-facing failure that route handlers map to a clean HTTP status. */
export class CustomerAuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'CustomerAuthError';
    this.code = code;
    this.status = status;
  }
}

function getSecret(): string {
  const secret = process.env.CUSTOMER_AUTH_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new CustomerAuthError(
      'AUTH_NOT_CONFIGURED',
      'Customer auth is not configured (CUSTOMER_AUTH_SECRET unset)',
      500,
    );
  }
  return DEV_SECRET;
}

const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();
const hashCode = (code: string): string => createHash('sha256').update(code).digest('hex');
/** Crypto-random 6-digit numeric code (zero-padded). */
const generateCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** The verified customer principal carried by a session token. */
export interface CustomerIdentity {
  operatorId: string;
  email: string;
  /** The Customer row id when one exists for this email, else null. */
  customerId: string | null;
}

/** Sign a customer session token for the given identity. */
export async function issueCustomerToken(
  operatorId: string,
  email: string,
  customerId: string | null,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: customerId ?? email,
      operatorId,
      email,
      customerId,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    },
    getSecret(),
    'HS256',
  );
}

/**
 * Verify a customer bearer token and return its identity, scoped to `operatorId`.
 * Returns null for any invalid/expired/wrong-tenant token (never throws), so callers
 * can treat "no valid token" uniformly.
 */
export async function verifyCustomerToken(
  token: string,
  operatorId: string,
): Promise<CustomerIdentity | null> {
  try {
    const payload = await verify(token, getSecret(), 'HS256');
    if (!payload || payload.operatorId !== operatorId || typeof payload.email !== 'string') {
      return null;
    }
    const customerId = typeof payload.customerId === 'string' ? payload.customerId : null;
    return { operatorId, email: payload.email, customerId };
  } catch {
    return null;
  }
}

/** Extract + verify a customer identity from a request's Authorization header. */
export async function customerIdentityFromHeader(
  authorization: string | undefined,
  operatorId: string,
): Promise<CustomerIdentity | null> {
  const token =
    authorization && authorization.toLowerCase().startsWith('bearer ')
      ? authorization.slice(7).trim()
      : null;
  if (!token) return null;
  return verifyCustomerToken(token, operatorId);
}

/**
 * Issue a login code for an email and (best-effort) email it. Invalidates any prior
 * unconsumed codes for this tenant + email first. Returns `devCode` only when email
 * is unconfigured and we're not in production.
 */
export async function requestLoginCode(operatorId: string, rawEmail: string) {
  const email = normalizeEmail(rawEmail);
  if (!email.includes('@')) {
    throw new CustomerAuthError('INVALID_EMAIL', 'A valid email is required');
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  await withTenant(operatorId, async (tx) => {
    await tx.customerOtp.updateMany({
      where: { email, consumed_at: null },
      data: { consumed_at: new Date() },
    });
    await tx.customerOtp.create({
      data: { operator_id: operatorId, email, code_hash: hashCode(code), expires_at: expiresAt },
    });
  });

  const mail = await sendLoginCode({ operatorId, email, code, expiresInMinutes: CODE_TTL_MS / 60_000 });
  // Surface the code in the response only when it was NOT actually delivered (email
  // off or the send failed) AND we're not in production — a dev/test convenience so
  // the flow is completable headlessly. Never exposed once email truly sends or in prod.
  const exposeDev = !mail.sent && process.env.NODE_ENV !== 'production';

  return {
    sent: mail.sent,
    expiresAt,
    ...(exposeDev ? { devCode: code } : {}),
  };
}

/**
 * Verify a submitted code for an email. On success consumes the code, resolves the
 * Customer row (if any), and returns a signed session token. On a wrong code,
 * increments the attempt counter and throws.
 */
export async function verifyLoginCode(operatorId: string, rawEmail: string, rawCode: string) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode).trim();

  // Load the active code (own tx).
  const otp = await withTenant(operatorId, (tx) =>
    tx.customerOtp.findFirst({ where: { email, consumed_at: null }, orderBy: { created_at: 'desc' } }),
  );
  if (!otp) {
    throw new CustomerAuthError('CODE_NOT_FOUND', 'No active login code — request a new one', 400);
  }
  if (otp.expires_at.getTime() <= Date.now()) {
    throw new CustomerAuthError('CODE_EXPIRED', 'This code has expired — request a new one', 400);
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    throw new CustomerAuthError('TOO_MANY_ATTEMPTS', 'Too many attempts — request a new code', 429);
  }
  if (otp.code_hash !== hashCode(code)) {
    // The increment must COMMIT even though we then reject — so it runs in its own
    // transaction, NOT one we abort by throwing (which would roll the counter back
    // and defeat the brute-force cap).
    await withTenant(operatorId, (tx) =>
      tx.customerOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } }),
    );
    throw new CustomerAuthError('INVALID_CODE', 'That code is incorrect', 401);
  }

  // Correct: consume the code and resolve the customer (own tx).
  const customer = await withTenant(operatorId, async (tx) => {
    await tx.customerOtp.update({ where: { id: otp.id }, data: { consumed_at: new Date() } });
    return tx.customer.findFirst({
      where: { email },
      select: { id: true, first_name: true, last_name: true, email: true },
    });
  });

  const token = await issueCustomerToken(operatorId, email, customer?.id ?? null);
  return {
    token,
    expiresInSeconds: TOKEN_TTL_SECONDS,
    customer: customer ?? { id: null, email },
  };
}
