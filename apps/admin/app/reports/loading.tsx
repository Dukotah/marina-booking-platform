import { Skeleton } from '@marina/ui';

/**
 * Reports loading state. Mirrors the page layout (KPI row, chart card, detail
 * cards) so the transition is calm rather than a flash of empty space while the
 * tenant-scoped aggregation runs.
 */
export default function ReportsLoading() {
  return (
    <div className="mx-auto w-full max-w-7xl p-4 md:p-6 lg:p-8">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>

      <div className="flex flex-col gap-6">
        <Skeleton className="h-9 w-full max-w-md" />
        <Skeleton className="h-10 w-64" />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>

        <Skeleton className="h-80 w-full rounded-lg" />

        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-64 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
