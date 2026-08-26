import { AlertTriangle } from 'lucide-react';
import { AuthorizationError } from '@marina/auth';
import { EmptyState } from '@marina/ui';
import { AdminShell } from '../../../components/shell/AdminShell';
import { PageHeader } from '../../../components/shell';
import { requirePermission } from '../../../lib/session';
import { getLocationRollUp } from '../../../components/reports/queries';
import { LocationDateFilter } from '../../../components/reports/LocationDateFilter';
import { LocationRollUpView } from '../../../components/reports/LocationRollUpView';

export const metadata = {
  title: 'Locations roll-up',
};

/** Live, session/search-param dependent — always render fresh. */
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Multi-location roll-up (Upmarket §1 #6-B): combined revenue + occupancy across
 * every location, read-only. Gated behind `report:read`; renders a denied state
 * rather than throwing, so the chrome stays intact. Every figure is tenant-scoped
 * (RLS).
 */
export default async function LocationRollUpPage({ searchParams }: PageProps) {
  try {
    await requirePermission('report:read');
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return (
        <AdminShell>
          <PageHeader title="Locations roll-up" description="Combined revenue and occupancy by location." />
          <EmptyState
            icon={AlertTriangle}
            title="You don't have access to reports"
            description="Reporting requires the report:read permission. Ask an owner or admin to grant it."
          />
        </AdminShell>
      );
    }
    throw err;
  }

  const from = single(searchParams?.from);
  const to = single(searchParams?.to);
  const report = await getLocationRollUp(from, to);

  return (
    <AdminShell>
      <PageHeader
        title="Locations roll-up"
        description="Combined revenue and occupancy across all of your locations."
      />
      <div className="flex flex-col gap-6">
        <LocationDateFilter from={report.range.from} to={report.range.to} />
        <LocationRollUpView report={report} />
      </div>
    </AdminShell>
  );
}
