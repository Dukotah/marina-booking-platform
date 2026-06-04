import Link from 'next/link';
import { SearchX, ArrowLeft } from 'lucide-react';
import { AdminShell } from '../../components/shell/AdminShell';

/** Shown when notFound() is called for a missing/wrong-tenant order id. */
export default function OrderNotFound() {
  return (
    <AdminShell>
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
            <SearchX className="h-6 w-6" aria-hidden />
          </div>
          <h1 className="text-lg font-semibold text-slate-900">Order not found</h1>
          <p className="mt-2 text-sm text-slate-500">
            This order doesn&apos;t exist or has been removed.
          </p>
          <Link
            href="/orders"
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to orders
          </Link>
        </div>
      </div>
    </AdminShell>
  );
}
