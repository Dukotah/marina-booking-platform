'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '../../components/ui';

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
      <div className="max-w-md rounded-lg border border-line bg-surface p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-600">
          <AlertTriangle className="h-6 w-6" aria-hidden />
        </div>
        <h1 className="text-lg font-semibold text-ink">
          {isAuth ? 'Access denied' : 'Something went wrong'}
        </h1>
        <p className="mt-2 text-sm text-ink-body">
          {isAuth
            ? "You don't have permission to view orders. Ask an administrator if you need access."
            : 'We could not load this page. Please try again in a moment.'}
        </p>
        {!isAuth ? (
          <Button variant="primary" onClick={reset} className="mt-5">
            <RotateCcw className="h-4 w-4" aria-hidden />
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}
