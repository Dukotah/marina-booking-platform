import Link from 'next/link';
import { ArrowLeft, UserX } from 'lucide-react';
import { AdminShell } from '../../../components/shell';
import { buttonClasses } from '../../../components/ui';

/**
 * Graceful not-found state for a missing/cross-tenant customer id. RLS already
 * prevents reading another operator's customer, so an out-of-tenant id resolves
 * here rather than leaking existence.
 */
export default function CustomerNotFound() {
  return (
    <AdminShell>
      <div className="mx-auto max-w-md py-16 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted text-ink-muted">
          <UserX className="h-6 w-6" aria-hidden />
        </div>
        <h1 className="text-lg font-semibold text-ink">Customer not found</h1>
        <p className="mt-1 text-sm text-ink-muted">
          This customer doesn&apos;t exist or isn&apos;t part of your account.
        </p>
        <Link href="/customers" className={buttonClasses('primary', 'md', 'mt-6')}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to customers
        </Link>
      </div>
    </AdminShell>
  );
}
