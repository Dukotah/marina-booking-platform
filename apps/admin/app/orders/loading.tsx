import { AdminShell } from '../../components/shell/AdminShell';
import { PageHeader } from '../../components/shell/PageHeader';

/** Skeleton shown while the orders list query runs. */
export default function OrdersLoading() {
  return (
    <AdminShell>
      <PageHeader title="Orders" description="Search, filter, and manage every booking." />
      <div className="mb-4 flex gap-3">
        <div className="h-11 w-64 animate-pulse rounded-lg bg-surface-muted" />
        <div className="h-11 w-36 animate-pulse rounded-lg bg-surface-muted" />
        <div className="h-11 w-40 animate-pulse rounded-lg bg-surface-muted" />
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-line px-4 py-4 last:border-0">
            <div className="h-4 w-24 animate-pulse rounded bg-surface-muted" />
            <div className="h-4 flex-1 animate-pulse rounded bg-surface-muted" />
            <div className="h-4 w-20 animate-pulse rounded bg-surface-muted" />
          </div>
        ))}
      </div>
    </AdminShell>
  );
}
