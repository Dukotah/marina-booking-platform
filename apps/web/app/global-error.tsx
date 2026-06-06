'use client';

/**
 * Fatal fallback for the customer portal.
 *
 * `global-error.tsx` replaces the ROOT layout (including <html>/<body>), so it
 * only fires when the layout itself throws. It cannot rely on globals.css being
 * applied, so all styling is inline to guarantee it renders standalone. Reports
 * through the observability seam before showing a minimal recover screen.
 */

import { useEffect } from 'react';
import { captureError } from '@/lib/observability';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureError(error, { source: 'web/global-error', digest: error.digest });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#f8fafc',
          color: '#0f172a',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        }}
      >
        <div style={{ maxWidth: 420, padding: 24, textAlign: 'center' }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 8px' }}>
            Something went wrong
          </h1>
          <p style={{ color: '#475569', margin: '0 0 24px', lineHeight: 1.5 }}>
            We hit an unexpected problem. Please try reloading the page in a moment.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              cursor: 'pointer',
              borderRadius: 12,
              border: 'none',
              padding: '10px 20px',
              fontSize: 14,
              fontWeight: 600,
              color: '#ffffff',
              backgroundColor: '#0ea5e9',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
