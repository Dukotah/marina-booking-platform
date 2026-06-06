'use client';

/**
 * App-level route error boundary for the operator admin app.
 *
 * Catches render/data errors thrown under the root layout (the per-area
 * boundaries like orders/error.tsx still take precedence for their segments) and
 * shows a recover card instead of a white screen. Reports through the shared
 * observability seam. Standalone styling (not AdminShell — that's an async server
 * component and can't render inside a client boundary), matching the existing
 * orders/error.tsx card.
 */

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { captureError } from '../lib/observability';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureError(error, { source: 'admin/route-error', digest: error.digest });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-600">
          <AlertTriangle className="h-6 w-6" aria-hidden />
        </div>
        <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-500">
          We couldn&apos;t load this page. Please try again in a moment.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          <RotateCcw className="h-4 w-4" aria-hidden />
          Try again
        </button>
      </div>
    </div>
  );
}
