'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

/**
 * Route error boundary for the orders area. An AuthorizationError thrown by
 * requirePermission (missing order:read) lands here as a clean denied state;
 * other failures get a retry affordance. Never leaks stack details to the UI.
 */
export default function OrdersError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[orders] route error:', error);
  }, [error]);

  const isAuth = error.message?.toLowerCase().includes('permission');

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-600">
          <AlertTriangle className="h-6 w-6" aria-hidden />
        </div>
        <h1 className="text-lg font-semibold text-slate-900">
          {isAuth ? 'Access denied' : 'Something went wrong'}
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          {isAuth
            ? "You don't have permission to view orders. Ask an administrator if you need access."
            : 'We could not load this page. Please try again in a moment.'}
        </p>
        {!isAuth ? (
          <button
            type="button"
            onClick={reset}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            <RotateCcw className="h-4 w-4" aria-hidden />
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}
