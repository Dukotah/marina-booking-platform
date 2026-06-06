/**
 * Tiny observability seam for the Hono API.
 *
 * `captureError` is the single chokepoint `app.onError` (and any service that
 * wants to report) calls. Today it just `console.error`s a structured record so
 * failures are visible in the platform logs. It is intentionally env-gated and
 * dependency-free: when `SENTRY_DSN` is set we log that the error WOULD be
 * forwarded, and the one commented block below is exactly where a real SDK
 * (`@sentry/node`, etc.) would plug in — no vendor package is installed yet (no
 * account available), so this stays a no-op forwarder for now.
 */

export interface ErrorContext {
  /** Where the error surfaced, e.g. 'api/onError'. */
  source: string;
  /** Request method, when available. */
  method?: string;
  /** Request path, when available. */
  path?: string;
  /** Resolved tenant, when available. */
  operatorId?: string;
  /** Any extra structured fields worth attaching to the report. */
  [key: string]: unknown;
}

/** True when a Sentry (or compatible) DSN is configured. */
function dsnConfigured(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}

/**
 * Report an error through the API's single observability seam.
 *
 * Structured console output today; forwards to a real SDK once one is wired and
 * `SENTRY_DSN` is present. Never throws (reporting must not mask the original
 * failure or the response path).
 */
export function captureError(err: unknown, context: ErrorContext): void {
  try {
    const error = err instanceof Error ? err : new Error(String(err));
    // Structured so it greps cleanly in the platform logs.
    console.error('[observability] captureError', {
      ...context,
      message: error.message,
      stack: error.stack,
    });

    if (dsnConfigured()) {
      // --- SDK plug-in point -------------------------------------------------
      // Once a vendor SDK is installed + initialized (e.g. `@sentry/node`),
      // forward here instead of just logging:
      //
      //   import * as Sentry from '@sentry/node';
      //   Sentry.captureException(error, { extra: context });
      //
      // Until then we note that forwarding would have happened.
      console.error('[observability] (would forward to Sentry; SDK not installed)');
    }
  } catch {
    // Reporting must never throw and mask the real error.
  }
}
