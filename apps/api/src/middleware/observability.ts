/**
 * Observability middleware — production-grade request logging, error handling,
 * and a readiness probe. Dependency-free; matches the existing middleware style
 * (`createMiddleware<Env>`).
 *
 * The orchestrator (app.ts) wires these in by:
 *   app.use('*', requestLogger)          — replaces hono/logger
 *   app.onError(errorHandler)            — replaces the inline onError block
 *   app.get('/ready', readyHandler)      — new readiness endpoint
 */

import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { AuthorizationError } from '@marina/auth';
import { adminPrisma } from '@marina/database';
import type { Env } from '../context.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pull the request-id that requestLogger stored.  We try the context variable
 * first (set by the middleware before calling next()), then fall back to the
 * response header that was already written, and finally produce a placeholder
 * so error responses always carry *something*.
 */
function getRequestId(c: Context): string {
  // The variable name used by requestLogger — intentionally kept private to
  // this module so nothing outside leaks it.
  try {
    // c.get() can throw when called outside a middleware context; guard it.
    const v = (c as Context<Env>).get('requestId');
    if (v) return v;
  } catch {
    // fall through
  }
  return c.res.headers.get('x-request-id') ?? 'unknown';
}

// ---------------------------------------------------------------------------
// captureError — APM seam
// ---------------------------------------------------------------------------

/**
 * Error-monitoring seam.  Right now this is a no-op-ish structured logger:
 * when ERROR_DSN (or SENTRY_DSN) is present it emits a JSON error line tagged
 * for ingestion; when neither is set it emits nothing (silent in production,
 * safe in tests).
 *
 * **To wire a real APM SDK** (e.g. Sentry, Highlight, Axiom):
 *   1. `npm add @sentry/node` (or your SDK of choice) in apps/api.
 *   2. Replace the `console.error(JSON.stringify(...))` block below with the
 *      SDK capture call, e.g. `Sentry.captureException(err, { extra: meta })`.
 *   3. Set ERROR_DSN (or SENTRY_DSN) in your environment so the guard is true.
 *
 * Signature is intentionally generic so call-sites don't need to change when
 * the implementation is upgraded from structured-log to a real SDK call.
 */
export function captureError(
  err: unknown,
  meta?: Record<string, unknown>,
): void {
  const dsn = process.env.ERROR_DSN ?? process.env.SENTRY_DSN;

  if (!dsn) {
    // No DSN configured — stay silent.  A real SDK init call would be the
    // place to bail out gracefully here too.
    return;
  }

  // ---- REPLACE THIS BLOCK WITH YOUR APM SDK CALL ----
  // e.g. Sentry.captureException(err, { extra: meta });
  // ----------------------------------------------------
  const payload: Record<string, unknown> = {
    level: 'error',
    ts: new Date().toISOString(),
    // Only safe fields: name + message, never the full stack in the
    // structured payload (avoid leaking internals to an external sink).
    error:
      err instanceof Error
        ? { name: err.name, message: err.message }
        : String(err),
    ...meta,
  };
  console.error(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// requestLogger
// ---------------------------------------------------------------------------

/**
 * Request logger middleware.
 *
 * - Generates a `crypto.randomUUID()` request-id.
 * - Stashes it as the `_requestId` context variable (module-private) AND sets
 *   it as the `x-request-id` response header so clients can correlate logs.
 * - After the handler chain resolves, emits ONE structured JSON line at
 *   level:"info" to stdout.
 * - Uses `performance.now()` for sub-millisecond wall-clock duration (immune
 *   to clock-skew / `Date.now()` resolution issues at high req/s).
 * - Includes `operatorId` when set (tenant routes only; undefined on
 *   /health, /ready, /webhooks, /jobs, /signup).
 *
 * Replaces `app.use('*', logger())` from hono/logger.
 */
export const requestLogger = createMiddleware<Env>(async (c, next) => {
  const requestId = crypto.randomUUID();

  // Store for errorHandler + downstream code that wants it (typed Env var).
  c.set('requestId', requestId);

  // Set early so the header is present even if an error short-circuits next().
  c.header('x-request-id', requestId);

  const t0 = performance.now();

  await next();

  const durationMs = Math.round((performance.now() - t0) * 100) / 100; // 2 d.p.

  // operatorId is only defined after tenantMiddleware runs; undefined for
  // platform-level routes (/health, /ready, /webhooks, /jobs, /signup).
  const operatorId: string | undefined = (() => {
    try {
      return c.var.operatorId;
    } catch {
      return undefined;
    }
  })();

  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level: 'info',
    requestId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    durationMs,
  };

  if (operatorId !== undefined) {
    line.operatorId = operatorId;
  }

  console.log(JSON.stringify(line));
});

// ---------------------------------------------------------------------------
// errorHandler
// ---------------------------------------------------------------------------

/**
 * Central error handler — pass to `app.onError(errorHandler)`.
 *
 * Mapping priority:
 *   1. AuthorizationError (from @marina/auth)          → 403 + permission
 *   2. Any typed service error with a numeric .status   → that status + code
 *      (StripePaymentError, StripeNotConfiguredError, ProvisioningError,
 *       CustomerAuthError — all carry customer-safe messages by design)
 *   3. Everything else                                  → 500 (internals hidden)
 *
 * Unknown errors are captured via captureError() before the sanitised 500 is
 * returned, so they still reach your APM even though their message is never
 * sent to the client.
 */
export function errorHandler(err: unknown, c: Context): Response {
  const requestId = getRequestId(c);

  // 1. AuthorizationError — fine-grained 403.
  if (err instanceof AuthorizationError) {
    captureError(err, { requestId, kind: 'authorization' });
    return c.json(
      { error: err.message, permission: err.permission, requestId },
      403,
    );
  }

  // 2. Typed service errors — they carry a numeric status + customer-safe msg.
  //    We accept any Error subclass that explicitly declares a numeric `status`
  //    in [400, 599], which covers:
  //      StripePaymentError, StripeNotConfiguredError, ProvisioningError,
  //      CustomerAuthError (and any future additions that follow the pattern).
  if (
    err instanceof Error &&
    'status' in err &&
    typeof (err as Error & { status: unknown }).status === 'number'
  ) {
    const typed = err as Error & { status: number; code?: string };
    const status = typed.status;

    if (status >= 400 && status <= 599) {
      // Client-facing errors (4xx) are informational; 5xx service errors are
      // worth capturing so ops can see them in the APM.
      if (status >= 500) {
        captureError(err, { requestId, kind: 'service_error', status });
      }

      const body: Record<string, unknown> = {
        error: typed.message,
        requestId,
      };
      if (typed.code !== undefined) {
        body.code = typed.code;
      }

      return c.json(body, status as Parameters<typeof c.json>[1]);
    }
  }

  // 3. Unexpected / unknown error — log full details server-side, return a
  //    sanitised 500 to the client (never leak message or stack).
  captureError(err, { requestId, kind: 'unhandled' });
  console.error(
    JSON.stringify({
      level: 'error',
      ts: new Date().toISOString(),
      requestId,
      kind: 'unhandled',
      error:
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : String(err),
    }),
  );

  return c.json({ error: 'Internal server error', requestId }, 500);
}

// ---------------------------------------------------------------------------
// readyHandler
// ---------------------------------------------------------------------------

/**
 * Readiness probe — `app.get('/ready', readyHandler)`.
 *
 * Differs from the liveness /health route (which just returns 200 immediately):
 * this checks that the database is actually reachable before reporting ready,
 * making it safe to use as a Kubernetes readinessProbe / load-balancer health
 * check target.
 *
 * Uses a 3-second AbortController timeout so a hung DB doesn't stall the probe
 * indefinitely.  Returns:
 *   200 { ok: true,  db: 'up'   } — all systems go
 *   503 { ok: false, db: 'down' } — DB unreachable / timed out
 *
 * Never throws — all errors are caught internally.
 */
export async function readyHandler(c: Context): Promise<Response> {
  const DB_TIMEOUT_MS = 3_000;

  try {
    await Promise.race([
      adminPrisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('DB readiness check timed out')),
          DB_TIMEOUT_MS,
        ),
      ),
    ]);

    return c.json({ ok: true, db: 'up' }, 200);
  } catch (err) {
    // Log the failure server-side (not to captureError — this is expected
    // transient noise during restarts, not an application error).
    console.error(
      JSON.stringify({
        level: 'warn',
        ts: new Date().toISOString(),
        kind: 'readiness_check_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    return c.json({ ok: false, db: 'down' }, 503);
  }
}
