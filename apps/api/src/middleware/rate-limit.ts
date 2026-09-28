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
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import type { Env } from '../context.js';

/** Default window length in milliseconds. */
export const DEFAULT_WINDOW_MS = 60_000;
/** Default max requests allowed per key within a window (sensitive public routes). */
export const DEFAULT_MAX_REQUESTS = 30;

/**
 * How many reverse proxies we operate in front of this API (nginx, Vercel, a CDN).
 * 0 (the default) means the API is reached directly, so EVERY forwarding header is
 * client-authored and none of them can be trusted.
 */
const TRUSTED_PROXY_HOPS = (() => {
  const raw = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '0', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
})();

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
  /**
   * Trusted proxy depth for THIS limiter, overriding the TRUSTED_PROXY_HOPS env.
   * Mostly for tests; deployments should set the env once.
   */
  trustedProxyHops?: number;
}

interface WindowState {
  count: number;
  /** Epoch ms at which this window resets. */
  resetAt: number;
}

/**
 * Client IP for rate-limit keying, without trusting anything the client can write.
 *
 * The leftmost `x-forwarded-for` entry is CLIENT-AUTHORED: keying on it lets an
 * attacker rotate the header and mint a fresh budget per request, which switches
 * the limiter off entirely for booking spam and code enumeration. So the rule is
 * positional, not preferential:
 *
 *   chain = [...x-forwarded-for entries, socket address]
 *
 * The last `trustedHops` entries of that chain were appended by proxies WE run;
 * the entry just before them is the real client. With `trustedHops = 0` (direct
 * exposure — local dev, a bare VPS) that is simply the socket address, and every
 * forwarding header is ignored.
 *
 * No socket address available (e.g. `app.request()` in tests) and no trusted
 * proxy → a shared "unknown" bucket: an unattributable caller gets ONE budget,
 * not a budget per forged header.
 */
export function getClientIp(
  headerGetter: (name: string) => string | undefined,
  socketIp?: string | null,
  trustedHops: number = TRUSTED_PROXY_HOPS,
): string {
  const xff = headerGetter('x-forwarded-for');
  const chain = (xff ? xff.split(',').map((s) => s.trim()).filter(Boolean) : []);
  if (socketIp) chain.push(socketIp);

  // Index of the real client, counting the trusted proxy suffix off the end.
  // Clamped to 0: more claimed hops than chain entries just yields the leftmost.
  const idx = Math.max(0, chain.length - 1 - trustedHops);
  const candidate = chain[idx];
  if (candidate) {
    // With no trusted proxies, never step left of the socket address itself.
    if (trustedHops === 0) return socketIp ?? 'unknown';
    return candidate;
  }
  return socketIp ?? 'unknown';
}

/** The peer socket address for this request, when the runtime exposes one. */
function socketAddress(c: Context<Env>): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    // No underlying socket (unit tests via app.request(), exotic runtimes).
    return null;
  }
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

    const ip = getClientIp(
      (name) => c.req.header(name),
      socketAddress(c),
      options.trustedProxyHops ?? TRUSTED_PROXY_HOPS,
    );
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
