'use client';

/**
 * Route-segment error boundary for the customer portal.
 *
 * Catches render/data errors thrown anywhere under the root layout and shows a
 * friendly, on-brand retry screen instead of a white screen. The error is
 * reported through the shared observability seam (`captureError`) so it surfaces
 * in logs (and a real SDK, once wired). Styling uses the `--brand-color` CSS var
 * (defaulted in globals.css) so it stays white-label.
 */

import { useEffect } from 'react';
import Link from 'next/link';
import { captureError } from '@/lib/observability';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureError(error, { source: 'web/route-error', digest: error.digest });
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-4 py-16 text-center">
      <span
        aria-hidden
        className="flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-sm"
        style={{ backgroundColor: 'var(--brand-color)' }}
      >
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </span>
      <h1 className="mt-5 text-2xl font-bold tracking-tight text-slate-900">
        Something went wrong
      </h1>
      <p className="mt-2 text-slate-600">
        We hit an unexpected problem loading this page. Please try again — if it keeps
        happening, head back and start over.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-xl px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
          style={{ backgroundColor: 'var(--brand-color)' }}
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          Back to booking
        </Link>
      </div>
    </main>
  );
}
