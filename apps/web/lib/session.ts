/**
 * Customer session — a thin wrapper over an httpOnly cookie holding the
 * email-OTP session token (D-017).
 *
 * The token is a stateless signed JWT minted by the API after a successful
 * `verify`; the API is the only authority that validates it (per request, scoped
 * to the resolved operator). We store it in an httpOnly cookie so client JS can't
 * read it, and forward it as a bearer on token-gated self-service calls.
 *
 * `getCustomerSession` is safe to call during render (it only reads the cookie).
 * `setCustomerSession` / `clearCustomerSession` mutate the cookie and may only be
 * called from a Server Action or Route Handler (Next's cookie-write rule).
 *
 * NOTE: we do not verify the token here — it's opaque to the web app. We trust the
 * cookie because it's httpOnly and was set only after the API verified the code.
 * Every privileged call re-presents the token to the API, which is the real gate.
 */
import { cookies } from 'next/headers';

const COOKIE_NAME = 'mb_customer';

export interface CustomerSession {
  /** The signed bearer token sent to token-gated API endpoints. */
  token: string;
  /** The verified email (display + lookup prefill). */
  email: string;
}

/** Read the current customer session from the cookie, or null if not signed in. */
export function getCustomerSession(): CustomerSession | null {
  const raw = cookies().get(COOKIE_NAME)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CustomerSession>;
    if (typeof parsed.token === 'string' && typeof parsed.email === 'string') {
      return { token: parsed.token, email: parsed.email };
    }
  } catch {
    // Malformed cookie — treat as signed out.
  }
  return null;
}

/**
 * Persist a customer session. Call only from a Server Action / Route Handler.
 * @param maxAgeSeconds token lifetime, mirrored from the API's `expiresInSeconds`.
 */
export function setCustomerSession(
  session: CustomerSession,
  maxAgeSeconds: number,
): void {
  cookies().set(COOKIE_NAME, JSON.stringify(session), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

/** Clear the customer session (sign out). Call only from a Server Action / Route Handler. */
export function clearCustomerSession(): void {
  cookies().delete(COOKIE_NAME);
}
