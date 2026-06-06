import 'server-only';

/**
 * Read the customer session on the web side.
 *
 * The session token is an HMAC-signed `base64url(JSON).signature` string issued by
 * the API (see apps/api/src/lib/customer-session.ts). The web app does NOT hold
 * AUTH_SECRET and does not need to: it decodes the (unverified) payload only to learn
 * WHICH order to display, then calls the API, which forwards the token and verifies
 * it cryptographically before returning any data. So a tampered cookie can route to
 * an order number but the API still rejects it — the web read is purely for routing.
 */

import { cookies } from 'next/headers';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/api';

export interface CustomerSessionView {
  orderNumber: string;
  email: string;
}

/** Decode the session payload from the cookie. Returns null if missing/malformed. */
export function getCustomerSession(): CustomerSessionView | null {
  const token = cookies().get(CUSTOMER_SESSION_COOKIE)?.value;
  if (!token) return null;

  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);

  let payload: { orderNumber?: unknown; email?: unknown; exp?: unknown };
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    payload = JSON.parse(json);
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
  // Soft client-side expiry check (the cookie maxAge already enforces this; the API
  // enforces it authoritatively). Avoids rendering a stale "logged in" shell.
  if (Date.now() > payload.exp) return null;

  return { orderNumber: payload.orderNumber, email: payload.email };
}
