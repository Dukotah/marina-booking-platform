import Link from 'next/link';
import { ArrowLeft, UserX } from 'lucide-react';
import { AdminShell } from '../../../components/shell';

/**
 * Graceful not-found state for a missing/cross-tenant customer id. RLS already
 * prevents reading another operator's customer, so an out-of-tenant id resolves
 * here rather than leaking existence.
 */
export default function CustomerNotFound() {
  return (
    <AdminShell>
      <div className="mx-auto max-w-md py-16 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <UserX className="h-6 w-6" aria-hidden />
        </div>
        <h1 className="text-lg font-semibold text-slate-900">Customer not found</h1>
        <p className="mt-1 text-sm text-slate-500">
          This customer doesn&apos;t exist or isn&apos;t part of your account.
        </p>
        <Link
          href="/customers"
          className="mt-6 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to customers
        </Link>
      </div>
    </AdminShell>
  );
}
