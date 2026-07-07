'use client';

// Root error boundary. Having an explicit App-Router global-error also stops Next
// 14.2 from falling back to the Pages-Router `_error` page when exporting /500,
// which was throwing "<Html> should not be imported outside of pages/_document".
// It must render its own <html>/<body> because it replaces the root layout.
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 p-8 text-center text-slate-900">
        <h1 className="text-2xl font-bold">Something went wrong</h1>
        <p className="text-sm text-slate-600">An unexpected error occurred in the operator console.</p>
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
        >
          Try again
        </button>
      </body>
    </html>
  );
}
