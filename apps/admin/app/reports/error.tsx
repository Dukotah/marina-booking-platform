'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, EmptyState } from '@marina/ui';

/**
 * Reports route error boundary. Keeps the failure contained to the page content
 * (the shell/nav stay usable) and offers a retry, so an aggregation hiccup never
 * leaves the operator on a broken screen — our zero-broken-pages bar.
 */
export default function ReportsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface for observability; the digest correlates with server logs.
    console.error('Reports page error:', error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-7xl p-4 md:p-6 lg:p-8">
      <EmptyState
        icon={AlertTriangle}
        title="We couldn't load your reports"
        description="Something went wrong while building this report. Please try again."
        action={
          <Button type="button" variant="brand" size="sm" onClick={reset}>
            Try again
          </Button>
        }
      />
    </div>
  );
}
