/**
 * rateLimit.ts — In-memory rate limiter + security headers middleware.
 *
 * ⚠️  IN-MEMORY STORE CAVEAT:
 * Counters live in a module-level Map on the single Node process. This is
 * perfectly correct for a single-instance deployment (the common case during
 * early SaaS growth). If you scale horizontally behind a load balancer you
 * MUST replace `store` with a shared backend (Redis / Upstash `@upstash/ratelimit`).
 * Swap the `getEntry` / `putEntry` helpers and nothing else changes.
 *
 * Keying scheme: `<name>:<clientIp>` where
 *   - `name`     is the limiter name (e.g. "signup", "otp-request")
 *   - `clientIp` is resolved from `x-forwarded-for` (first hop), then
 *                `x-real-ip`, falling back to the constant "127.0.0.1" in
 *                environments where no proxy header is present (local dev).
 *
 * Window strategy: fixed window. A window starts on the first request and
 * expires `windowMs` milliseconds later. Entries are evicted lazily on access
 * plus a light periodic sweep (every SWEEP_INTERVAL_MS, at most once per
 * request) so the Map never leaks indefinitely under zero traffic.
 */

import { createMiddleware } from 'hono/factory';
import type { Env } from '../context.js';

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------

interface WindowEntry {
  count: number;
  /** Absolute timestamp (ms) when this window expires. */
  expiresAt: number;
}

/**
 * Module-level counter store.
 * Key: `<name>:<ip>` — see `storeKey()`.
 */
const store = new Map<string, WindowEntry>();

/** Milliseconds between periodic sweeps of the whole map. */
const SWEEP_INTERVAL_MS = 60_000; // once per minute
let lastSweep = Date.now();

/** Remove all expired entries. Cheap: O(n) over the map size. */
function sweep(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now >= entry.expiresAt) {
      store.delete(key);
    }
  }
  lastSweep = now;
}

/** Conditionally run the periodic sweep (at most once per SWEEP_INTERVAL_MS). */
function maybeSweep(): void {
  if (Date.now() - lastSweep >= SWEEP_INTERVAL_MS) {
    sweep();
  }
}

// ---------------------------------------------------------------------------
// IP resolution
// ---------------------------------------------------------------------------

const FALLBACK_IP = '127.0.0.1';

/**
 * Resolve the client IP from standard proxy headers.
 *
 * `x-forwarded-for` can be a comma-separated list of IPs added by each proxy
 * hop; the first entry is the original client. We trim and take that value.
 * Falls back to `x-real-ip` (nginx / single-proxy convention), then the
 * FALLBACK_IP constant so local dev always works without a proxy.
 */
function resolveClientIp(req: { header(name: string): string | undefined }): string {
  const xff = req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const xri = req.header('x-real-ip');
  if (xri) return xri.trim();
  return FALLBACK_IP;
}

function storeKey(name: string, ip: string): string {
  return `${name}:${ip}`;
}

// ---------------------------------------------------------------------------
// Rate limiter factory
// ---------------------------------------------------------------------------

export interface RateLimitOptions {
  /**
   * Length of each fixed window in milliseconds.
   * e.g. 60_000 = 1 minute.
   */
  windowMs: number;
  /**
   * Maximum number of requests allowed within a window.
   */
  max: number;
  /**
   * Logical name for this limiter — used as part of the store key so multiple
   * limiters can coexist without key collisions.
   * e.g. "signup", "slug-check", "otp-request", "booking"
   */
  name: string;
}

/**
 * Factory returning a Hono middleware that enforces a fixed-window rate limit.
 *
 * Usage (orchestrator wires this onto specific routes, not here):
 *
 *   app.post('/signup', signupLimiter, signupHandler);
 *
 * When the limit is exceeded the middleware short-circuits with:
 *   HTTP 429
 *   Retry-After: <seconds until window resets>
 *   X-RateLimit-Limit: <max>
 *   X-RateLimit-Remaining: 0
 *   Content-Type: application/json
 *   { "error": "Too many requests. Please slow down.", "code": "RATE_LIMITED" }
 *
 * Allowed requests receive:
 *   X-RateLimit-Limit: <max>
 *   X-RateLimit-Remaining: <remaining after this request>
 */
export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, name } = opts;

  return createMiddleware<Env>(async (c, next) => {
    // Periodic sweep — free-list old entries so the Map doesn't grow forever.
    maybeSweep();

    const ip = resolveClientIp(c.req);
    const key = storeKey(name, ip);
    const now = Date.now();

    // Fetch or initialise the window entry.
    let entry = store.get(key);
    if (!entry || now >= entry.expiresAt) {
      // First request in this window (or the previous window has expired).
      entry = { count: 1, expiresAt: now + windowMs };
      store.set(key, entry);
    } else {
      entry.count += 1;
    }

    const remaining = Math.max(0, max - entry.count);
    const retryAfterSec = Math.ceil((entry.expiresAt - now) / 1_000);

    // Always set informational headers on the response.
    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(remaining));

    if (entry.count > max) {
      c.header('Retry-After', String(retryAfterSec));
      return c.json(
        { error: 'Too many requests. Please slow down.', code: 'RATE_LIMITED' },
        429,
      );
    }

    await next();
  });
}

// ---------------------------------------------------------------------------
// Pre-configured limiter instances
// ---------------------------------------------------------------------------

/**
 * Strict limiter for POST /signup (operator self-registration).
 * 5 requests / 60 s per IP — prevents bulk tenant provisioning abuse.
 */
export const signupLimiter = rateLimit({ name: 'signup', max: 5, windowMs: 60_000 });

/**
 * Lenient limiter for GET /signup/slug-available (real-time availability check).
 * 30 requests / 60 s per IP — allows rapid typing/autocomplete without abuse.
 */
export const slugCheckLimiter = rateLimit({ name: 'slug-check', max: 30, windowMs: 60_000 });

/**
 * Strict limiter for POST /api/auth/customer/request (customer OTP send).
 * 5 requests / 60 s per IP — blocks SMS/email enumeration and spam.
 */
export const otpRequestLimiter = rateLimit({ name: 'otp-request', max: 5, windowMs: 60_000 });

/**
 * Moderate limiter for POST /api/bookings (booking creation).
 * 20 requests / 60 s per IP — allows a realistic burst while blocking scripted abuse.
 */
export const bookingLimiter = rateLimit({ name: 'booking', max: 20, windowMs: 60_000 });

// ---------------------------------------------------------------------------
// Security headers middleware
// ---------------------------------------------------------------------------

/**
 * Applies a minimal, appropriate set of security headers for a JSON API.
 *
 * Headers set:
 *   X-Content-Type-Options: nosniff
 *     — Prevents MIME-type sniffing; browsers must honour the declared
 *       Content-Type. Stops certain injection attacks on downloaded responses.
 *
 *   X-Frame-Options: DENY
 *     — Blocks this API from being embedded in an iframe (clickjacking guard).
 *       Irrelevant for pure JSON consumers but costs nothing.
 *
 *   Referrer-Policy: no-referrer
 *     — Suppresses the Referer header on requests originating from API
 *       responses, preventing URL leakage to third parties.
 *
 *   X-Permitted-Cross-Domain-Policies: none
 *     — Disallows Adobe Flash / Acrobat cross-domain access (belt-and-suspenders;
 *       these clients are obsolete but the header signals intentional policy).
 *
 * Intentionally omitted for a JSON API:
 *   Content-Security-Policy — only meaningful for HTML documents.
 *   Strict-Transport-Security — set at the TLS terminator / CDN layer; the API
 *     layer shouldn't own transport policy.
 *
 * Mount this middleware globally on the app (the orchestrator wires it):
 *
 *   app.use('*', securityHeaders);
 */
export const securityHeaders = createMiddleware<Env>(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Permitted-Cross-Domain-Policies', 'none');
});
