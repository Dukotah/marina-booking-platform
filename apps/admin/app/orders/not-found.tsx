import Link from 'next/link';
import { SearchX, ArrowLeft } from 'lucide-react';
import { AdminShell } from '../../components/shell/AdminShell';
import { buttonClasses } from '../../components/ui';

/** Shown when notFound() is called for a missing/wrong-tenant order id. */
export default function OrderNotFound() {
  return (
    <AdminShell>
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="max-w-md rounded-lg border border-line bg-surface p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted text-ink-muted">
            <SearchX className="h-6 w-6" aria-hidden />
          </div>
          <h1 className="text-lg font-semibold text-ink">Order not found</h1>
          <p className="mt-2 text-sm text-ink-body">
            This order doesn&apos;t exist or has been removed.
          </p>
          <Link href="/orders" className={buttonClasses('primary', 'md', 'mt-5')}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to orders
          </Link>
        </div>
      </div>
    </AdminShell>
  );
}
