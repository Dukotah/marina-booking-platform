/**
 * Stateless customer auth primitives (email-OTP → session) for the customer
 * booking portal. Roadmap 0.7 (customer half) — replaces the order#+email URL stub.
 *
 * DESIGN: everything here is STATELESS — there is intentionally NO new Prisma model
 * and NO migration (we cannot migrate in this environment). Both the OTP challenge
 * and the issued session are self-describing tokens authenticated by an HMAC over
 * AUTH_SECRET, so the server holds no per-login state:
 *
 *   - Challenge token (short-lived, ~10 min): proves the server issued a specific
 *     6-digit code for a specific {orderNumber, email}. Layout:
 *       base64url(JSON{ orderNumber, email, exp }) + "." + HMAC(payload + ":" + code)
 *     The code is NOT stored in the token; verify-otp recomputes the HMAC from the
 *     payload + the submitted code and constant-time compares. A wrong code yields a
 *     different HMAC, so it fails without the server remembering anything.
 *
 *   - Session token (~7 days): issued after a verified code. Layout:
 *       base64url(JSON{ orderNumber, email, customerId?, exp }) + "." + HMAC(payload)
 *     Order-access routes accept it (cookie or bearer) in place of the email param.
 *
 * TRADE-OFFS of the stateless approach (documented follow-ups):
 *   - OTP brute-force rate-limiting is NOT possible here: a stateless challenge
 *     can't count attempts (there's no row to increment). A real deployment should
 *     add a per-challenge / per-IP attempt counter (e.g. Redis/Upstash) or move OTP
 *     state into the DB. Mitigations in place: 6-digit space + short (~10 min) expiry.
 *   - Tokens can't be individually revoked before expiry (no server-side store).
 *     Keep the session window modest; rotate AUTH_SECRET to invalidate everything.
 */
import {
  createHmac,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

// ---------------------------------------------------------------------------
// Secret + config
// ---------------------------------------------------------------------------

/**
 * Insecure dev default mirrors the graceful-degradation posture used for Clerk /
 * Stripe gating: the app stays usable locally without secrets, but we warn loudly
 * so it can never silently ship to production unset.
 */
const INSECURE_DEV_SECRET = 'dev-insecure-auth-secret-change-me';
let warnedMissingSecret = false;

function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret && secret.length > 0) return secret;
  if (!warnedMissingSecret) {
    warnedMissingSecret = true;
    const msg =
      '[customer-session] AUTH_SECRET is not set — using an INSECURE dev default. ' +
      'Customer session/OTP tokens are NOT secure until AUTH_SECRET is configured.';
    if (process.env.NODE_ENV === 'production') {
      console.error(msg);
    } else {
      console.warn(msg);
    }
  }
  return INSECURE_DEV_SECRET;
}

/** OTP code lifetime. Short to limit the brute-force window (no stateful counter). */
export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
/** Issued session lifetime. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Low-level encoding / HMAC
// ---------------------------------------------------------------------------

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function b64urlDecode(s: string): string | null {
  try {
    return Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** HMAC-SHA256 of `data` under AUTH_SECRET, base64url-encoded. */
function hmac(data: string): string {
  return createHmac('sha256', authSecret()).update(data).digest('base64url');
}

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Normalize an email the same way everywhere (trim + lowercase). */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Generate a zero-padded 6-digit OTP code using a CSPRNG. */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

// ---------------------------------------------------------------------------
// OTP challenge token
// ---------------------------------------------------------------------------

interface ChallengePayload {
  orderNumber: string;
  email: string;
  exp: number;
}

/**
 * Build a challenge token binding a specific code to {orderNumber, email}. The code
 * itself is never embedded — only an HMAC over (payload + ":" + code).
 */
export function createChallenge(input: {
  orderNumber: string;
  email: string;
  code: string;
  now?: number;
}): string {
  const payload: ChallengePayload = {
    orderNumber: input.orderNumber,
    email: normalizeEmail(input.email),
    exp: (input.now ?? Date.now()) + OTP_TTL_MS,
  };
  const encoded = b64urlEncode(JSON.stringify(payload));
  const sig = hmac(`${encoded}:${input.code}`);
  return `${encoded}.${sig}`;
}

/**
 * Build a DECOY challenge for a request that did NOT match a real order/email. It is
 * shaped identically to a real challenge but signed with a random code the caller
 * never learns, so it can never verify — used so request-otp can't be used to
 * enumerate which order numbers exist (responses look identical on hit vs miss).
 */
export function createDecoyChallenge(input: {
  orderNumber: string;
  email: string;
  now?: number;
}): string {
  return createChallenge({ ...input, code: generateOtpCode() });
}

export type VerifyChallengeResult =
  | { ok: true; orderNumber: string; email: string }
  | { ok: false; reason: 'malformed' | 'expired' | 'bad_code' };

/** Verify a submitted code against a challenge token. Constant-time on the HMAC. */
export function verifyChallenge(
  challenge: string,
  code: string,
  now: number = Date.now(),
): VerifyChallengeResult {
  const dot = challenge.indexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  const encoded = challenge.slice(0, dot);
  const sig = challenge.slice(dot + 1);

  const json = b64urlDecode(encoded);
  if (!json) return { ok: false, reason: 'malformed' };
  let payload: ChallengePayload;
  try {
    payload = JSON.parse(json) as ChallengePayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof payload.orderNumber !== 'string' ||
    typeof payload.email !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = hmac(`${encoded}:${code}`);
  if (!safeEqual(expected, sig)) return { ok: false, reason: 'bad_code' };

  // Check expiry AFTER the HMAC compare so timing doesn't distinguish the two.
  if (now > payload.exp) return { ok: false, reason: 'expired' };

  return { ok: true, orderNumber: payload.orderNumber, email: payload.email };
}

// ---------------------------------------------------------------------------
// Session token
// ---------------------------------------------------------------------------

interface SessionPayload {
  orderNumber: string;
  email: string;
  customerId?: string;
  exp: number;
}

/** Issue a signed customer session token after a verified OTP. */
export function createSessionToken(input: {
  orderNumber: string;
  email: string;
  customerId?: string;
  now?: number;
}): string {
  const payload: SessionPayload = {
    orderNumber: input.orderNumber,
    email: normalizeEmail(input.email),
    ...(input.customerId ? { customerId: input.customerId } : {}),
    exp: (input.now ?? Date.now()) + SESSION_TTL_MS,
  };
  const encoded = b64urlEncode(JSON.stringify(payload));
  const sig = hmac(encoded);
  return `${encoded}.${sig}`;
}

export interface CustomerSession {
  orderNumber: string;
  email: string;
  customerId?: string;
  exp: number;
}

/** Verify + decode a session token. Returns null on any tamper/expiry/format error. */
export function verifySessionToken(
  token: string | undefined | null,
  now: number = Date.now(),
): CustomerSession | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  if (!safeEqual(hmac(encoded), sig)) return null;

  const json = b64urlDecode(encoded);
  if (!json) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(json) as SessionPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.orderNumber !== 'string' ||
    typeof payload.email !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }
  if (now > payload.exp) return null;

  return {
    orderNumber: payload.orderNumber,
    email: payload.email,
    ...(payload.customerId ? { customerId: payload.customerId } : {}),
    exp: payload.exp,
  };
}

/**
 * Extract a customer session token from an incoming request: prefer the
 * `Authorization: Bearer <token>` header, fall back to the
 * `marina_customer_session` cookie. Returns the raw token string or null.
 */
export const CUSTOMER_SESSION_COOKIE = 'marina_customer_session';

export function readSessionToken(headers: {
  authorization?: string | undefined;
  cookie?: string | undefined;
}): string | null {
  const authz = headers.authorization;
  if (authz && authz.toLowerCase().startsWith('bearer ')) {
    const t = authz.slice(7).trim();
    if (t) return t;
  }
  const cookie = headers.cookie;
  if (cookie) {
    for (const part of cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      if (name === CUSTOMER_SESSION_COOKIE) {
        return decodeURIComponent(part.slice(eq + 1).trim());
      }
    }
  }
  return null;
}
