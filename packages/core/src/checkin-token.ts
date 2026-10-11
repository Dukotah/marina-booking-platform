/**
 * HMAC-signed check-in token — the payload carried by a booking's confirmation
 * QR code.
 *
 * A guest's confirmation screen (and email) shows a QR encoding a scan URL whose
 * token names the order and the specific booked item. A staff device scans it;
 * the API verifies the HMAC and routes to the existing manifest check-in path.
 * The operator is NOT in the token: the scan endpoint runs inside the tenant-
 * scoped, staff-authenticated `/api` stack, so the operator is already a server
 * fact and the token only has to name the order/item unforgeably.
 *
 * The token is `base64url(JSON payload).base64url(HMAC-SHA256)`, the same shape
 * as the signed price quote (services/pricing-rules.ts) so the two read alike.
 *
 * Node-only (uses `node:crypto`). It is imported from the API route and from the
 * web confirmation server component — both run on the Node runtime.
 */
// Bare 'crypto' (not 'node:crypto') specifier: webpack recognizes the Node
// builtin and keeps it external for the server runtime. The 'node:' scheme is
// rejected by webpack's default resolver (UnhandledSchemeError) when this module
// is transpiled into the Next apps' server bundle, so we avoid it here. This
// module is only ever reached from Node (API + server components / server
// actions); it never enters a client bundle.
import { createHmac, timingSafeEqual } from 'crypto';

/** Decoded check-in token payload. `v` is the format version. */
export interface CheckinTokenPayload {
  v: 1;
  /** Public order number, e.g. "LSRA260604001". */
  on: string;
  /** The specific booked order-item id to check in. */
  iid: string;
}

export interface VerifiedCheckinToken {
  payload: CheckinTokenPayload;
  signatureValid: boolean;
}

/**
 * Stable dev-only signing key. In any real deployment `CHECKIN_TOKEN_SECRET`
 * (or the shared `CUSTOMER_SESSION_SECRET`) MUST be set — the web app signs the
 * token and the API verifies it, so a per-process random key would never agree
 * across the two processes. The constant below keeps local dev (where neither is
 * set) working deterministically; production throws rather than fall back.
 */
const DEV_FALLBACK_SECRET = 'marina-dev-checkin-token-secret-do-not-use-in-prod';

let cachedSecret: Buffer | null = null;
let warnedEphemeralSecret = false;

function checkinSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const configured =
    process.env.CHECKIN_TOKEN_SECRET?.trim() || process.env.CUSTOMER_SESSION_SECRET?.trim();
  if (configured) {
    cachedSecret = Buffer.from(configured, 'utf8');
    return cachedSecret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('checkin-token: CHECKIN_TOKEN_SECRET is required in production.');
  }
  if (!warnedEphemeralSecret) {
    warnedEphemeralSecret = true;
    console.warn(
      '[checkin-token] CHECKIN_TOKEN_SECRET is not set — signing check-in tokens ' +
        'with a shared dev key. Set CHECKIN_TOKEN_SECRET (or CUSTOMER_SESSION_SECRET) ' +
        'in any real deployment.',
    );
  }
  cachedSecret = Buffer.from(DEV_FALLBACK_SECRET, 'utf8');
  return cachedSecret;
}

/** Sign the canonical payload (version + order number + item id). */
function sign(payload: CheckinTokenPayload): string {
  // Canonical field order so the signature is over the meaning, not an encoding.
  const fingerprint = `${payload.v}\n${payload.on}\n${payload.iid}`;
  return createHmac('sha256', checkinSecret()).update(fingerprint).digest('base64url');
}

/**
 * Issue a check-in token for one booked item. Opaque to the guest and
 * unforgeable without the key.
 */
export function signCheckinToken(input: { orderNumber: string; orderItemId: string }): string {
  const payload: CheckinTokenPayload = {
    v: 1,
    on: input.orderNumber,
    iid: input.orderItemId,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(payload)}`;
}

/**
 * Decode and check a token. Returns null when the token is not even shaped like
 * one; a token that parses but fails its signature comes back with
 * `signatureValid: false` so the caller can reject cleanly rather than throw.
 */
export function verifyCheckinToken(token: string | null | undefined): VerifiedCheckinToken | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  let payload: CheckinTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CheckinTokenPayload;
  } catch {
    return null;
  }
  if (
    payload?.v !== 1 ||
    typeof payload.on !== 'string' ||
    !payload.on ||
    typeof payload.iid !== 'string' ||
    !payload.iid
  ) {
    return null;
  }

  const expectedSig = sign(payload);
  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  // Length-check first: timingSafeEqual throws on a length mismatch.
  const signatureValid =
    provided.length === expected.length && timingSafeEqual(provided, expected);

  return { payload, signatureValid };
}

/**
 * Build the scan URL a QR should encode for a given token, against a web/app
 * base. Kept here so web + email render an identical link.
 */
export function checkinScanUrl(baseUrl: string, token: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/api/checkin/scan?t=${encodeURIComponent(token)}`;
}

// Re-exported for tests that want to force a fresh secret read.
export function __resetCheckinSecretForTest(): void {
  cachedSecret = null;
  warnedEphemeralSecret = false;
}
