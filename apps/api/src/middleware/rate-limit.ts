/**
 * Lightweight in-memory rate limiter for PUBLIC / unauthenticated endpoints.
 *
 * This is a fixed-window counter keyed by `client IP + operator (tenant) + route`,
 * so one abusive client on one tenant can't brute-force order numbers, enumerate
 * promo codes, or DoS the self-reschedule / booking-create endpoints — while a
 * different tenant or a different client keeps its own independent budget.
 *
 * NOTE: state lives in this process's memory, so limits are enforced PER INSTANCE.
 * That's fine for the current single-instance deployment; when we scale horizontally
 * (or move to serverless) swap the store for Redis / Upstash so the window is shared
 * across instances. The public surface (factory + middleware) stays the same.
 */
import { createMiddleware } from 'hono/factory';
import type { Env } from '../context.js';

/** Default window length in milliseconds. */
export const DEFAULT_WINDOW_MS = 60_000;
/** Default max requests allowed per key within a window (sensitive public routes). */
export const DEFAULT_MAX_REQUESTS = 30;

export interface RateLimitOptions {
  /** Sliding window length in ms. Default: 60s. */
  windowMs?: number;
  /** Max requests permitted per key per window. Default: 30. */
  max?: number;
  /**
   * Optional bucket label mixed into the key so unrelated route groups don't share
   * the same budget. Defaults to the matched route path.
   */
  bucket?: string;
}

interface WindowState {
  count: number;
  /** Epoch ms at which this window resets. */
  resetAt: number;
}

/**
 * Best-effort client IP. Behind a proxy/CDN (Vercel, Cloudflare, nginx) the real
 * client is in `x-forwarded-for` (first hop) or `x-real-ip`. Falls back to a shared
 * "unknown" bucket so a missing header can't bypass the limiter entirely.
 */
export function getClientIp(
  headerGetter: (name: string) => string | undefined,
): string {
  const xff = headerGetter('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = headerGetter('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

/**
 * Create a rate-limit middleware with its own isolated in-memory store.
 *
 * Returns HTTP 429 with a JSON body and a `Retry-After` header (seconds) once a key
 * exceeds `max` requests within `windowMs`.
 */
export function rateLimit(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const max = options.max ?? DEFAULT_MAX_REQUESTS;
  const store = new Map<string, WindowState>();
  // Occasional sweep of expired entries so the store can't grow unbounded under
  // a stream of one-off keys (each unique IP creates an entry).
  let opsSinceSweep = 0;
  const SWEEP_EVERY = 1_000;

  function sweep(now: number) {
    for (const [key, state] of store) {
      if (state.resetAt <= now) store.delete(key);
    }
  }

  const middleware = createMiddleware<Env>(async (c, next) => {
    const now = Date.now();
    if (++opsSinceSweep >= SWEEP_EVERY) {
      opsSinceSweep = 0;
      sweep(now);
    }

    const ip = getClientIp((name) => c.req.header(name));
    // operatorId is set by tenantMiddleware before these public routes run; fall back
    // to the Host header (still tenant-ish) if it isn't, so the key is never empty.
    const operator = c.get('operatorId') ?? c.req.header('host') ?? 'no-tenant';
    const bucket = options.bucket ?? c.req.routePath;
    const key = `${ip}::${operator}::${bucket}`;

    const existing = store.get(key);
    if (!existing || existing.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (existing.count >= max) {
      const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      c.header('Retry-After', String(retryAfterSec));
      return c.json(
        {
          error: 'Too many requests. Please slow down and try again shortly.',
          retryAfterSeconds: retryAfterSec,
        },
        429,
      );
    }

    existing.count += 1;
    return next();
  });

  // Expose the store for tests / diagnostics (not part of the request contract).
  return Object.assign(middleware, {
    /** Clear all counters — useful for test isolation. */
    reset() {
      store.clear();
    },
  });
}
