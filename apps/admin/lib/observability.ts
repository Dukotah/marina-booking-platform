/**
 * Tiny observability seam for the operator admin app.
 *
 * `captureError` is the single chokepoint every error boundary (and any
 * try/catch that wants to report) calls. Today it just `console.error`s a
 * structured record so failures are visible in Vercel logs. It is intentionally
 * env-gated and dependency-free: when `NEXT_PUBLIC_SENTRY_DSN` is set we log that
 * the error WOULD be forwarded, and the one commented block below is exactly
 * where a real SDK (Sentry, Highlight, etc.) would plug in — no vendor package is
 * installed yet (no account available), so this stays a no-op forwarder for now.
 *
 * This module is safe to import from both Server Components and `"use client"`
 * boundaries — it touches only `console` and `process.env.NEXT_PUBLIC_*`.
 */

export interface ErrorContext {
  /** Where the error surfaced, e.g. 'admin/global-error', 'admin/route-error'. */
  source: string;
  /** Next's error boundary digest, when present. */
  digest?: string;
  /** Any extra structured fields worth attaching to the report. */
  [key: string]: unknown;
}

/** True when a Sentry (or compatible) DSN is configured for the browser. */
function dsnConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);
}

/**
 * Report an error through the app's single observability seam.
 *
 * Structured console output today; forwards to a real SDK once one is wired and
 * `NEXT_PUBLIC_SENTRY_DSN` is present. Never throws (reporting must not mask the
 * original failure).
 */
export function captureError(err: unknown, context: ErrorContext): void {
  try {
    const error = err instanceof Error ? err : new Error(String(err));
    // Structured so it greps cleanly in Vercel logs.
    console.error('[observability] captureError', {
      ...context,
      message: error.message,
      stack: error.stack,
    });

    if (dsnConfigured()) {
      // --- SDK plug-in point -------------------------------------------------
      // Once a vendor SDK is installed + initialized (e.g. `@sentry/nextjs`),
      // forward here instead of just logging:
      //
      //   import * as Sentry from '@sentry/nextjs';
      //   Sentry.captureException(error, { extra: context });
      //
      // Until then we note that forwarding would have happened.
      console.error('[observability] (would forward to Sentry; SDK not installed)');
    }
  } catch {
    // Reporting must never throw and mask the real error.
  }
}
