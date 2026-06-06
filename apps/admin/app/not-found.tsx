import Link from 'next/link';
import { SearchX, ArrowLeft } from 'lucide-react';

/**
 * App-root 404 for the admin app (unmatched paths not covered by a more specific
 * segment not-found). Standalone card — does not mount AdminShell, which is an
 * async server component that resolves the tenant/staff session and shouldn't run
 * for an arbitrary unmatched path.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <SearchX className="h-6 w-6" aria-hidden />
        </div>
        <h1 className="text-lg font-semibold text-slate-900">Page not found</h1>
        <p className="mt-2 text-sm text-slate-500">
          This page doesn&apos;t exist or has moved.
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
