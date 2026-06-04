import { AdminShell } from '../../components/shell/AdminShell';
import { PageHeader } from '../../components/shell/PageHeader';

/** Skeleton shown while the orders list query runs. */
export default function OrdersLoading() {
  return (
    <AdminShell>
      <PageHeader title="Orders" description="Search, filter, and manage every booking." />
      <div className="mb-4 flex gap-3">
        <div className="h-9 w-64 animate-pulse rounded-lg bg-slate-200" />
        <div className="h-9 w-36 animate-pulse rounded-lg bg-slate-200" />
        <div className="h-9 w-40 animate-pulse rounded-lg bg-slate-200" />
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-slate-100 px-4 py-4 last:border-0">
            <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
            <div className="h-4 flex-1 animate-pulse rounded bg-slate-100" />
            <div className="h-4 w-20 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </div>
    </AdminShell>
  );
}
