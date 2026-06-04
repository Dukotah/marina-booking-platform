import { AlertTriangle } from 'lucide-react';
import { AuthorizationError } from '@marina/auth';
import { EmptyState } from '@marina/ui';
import { AdminShell } from '../../components/shell/AdminShell';
import { PageHeader } from '../../components/shell';
import { requirePermission } from '../../lib/session';
import {
  getReportsBundle,
  resolveReportKind,
  type ReportKind,
} from '../../components/reports/queries';
import { ReportTabs } from '../../components/reports/ReportTabs';
import { ReportDateFilter } from '../../components/reports/ReportDateFilter';
import { ExportButton } from '../../components/reports/ExportButton';
import { RevenueReportView } from '../../components/reports/RevenueReportView';
import { TaxesFeesReportView } from '../../components/reports/TaxesFeesReportView';
import { OccupancyReportView } from '../../components/reports/OccupancyReportView';

export const metadata = {
  title: 'Reports',
};

/** Reports are live and depend on session/search params — always render fresh. */
export const dynamic = 'force-dynamic';

interface ReportsPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

/** First value when a search param arrives as an array. */
function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Reports page: revenue, taxes & fees, and occupancy over a selectable date
 * range, with CSV export. Every figure is tenant-scoped (RLS) and gated behind
 * `report:read`. Unlike the incumbent, this route never 404s — a missing/invalid
 * report kind falls back to revenue, an unknown range defaults to the last 30
 * days, and a permission failure renders a clear denied state in-page.
 */
export default async function ReportsPage({ searchParams }: ReportsPageProps) {
  // Gate the whole page on report:read. Render a denied state rather than letting
  // the error bubble, so navigation/chrome stay intact (no broken pages).
  try {
    await requirePermission('report:read');
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return (
        <AdminShell>
          <PageHeader title="Reports" description="Revenue, taxes & fees, and occupancy." />
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

  const reportKind: ReportKind = resolveReportKind(single(searchParams?.report));
  const from = single(searchParams?.from);
  const to = single(searchParams?.to);

  const bundle = await getReportsBundle(from, to);
  const { range, brandColor } = bundle;

  return (
    <AdminShell>
      <PageHeader
        title="Reports"
        description="Revenue, taxes & fees, and occupancy for your business."
        actions={<ExportButton reportKind={reportKind} from={range.from} to={range.to} />}
      />

      <div className="flex flex-col gap-6">
        <ReportDateFilter from={range.from} to={range.to} reportKind={reportKind} />
        <ReportTabs active={reportKind} from={range.from} to={range.to} />

        {reportKind === 'revenue' ? (
          <RevenueReportView report={bundle.revenue} brandColor={brandColor} />
        ) : null}
        {reportKind === 'taxes-fees' ? (
          <TaxesFeesReportView report={bundle.taxesFees} />
        ) : null}
        {reportKind === 'occupancy' ? (
          <OccupancyReportView report={bundle.occupancy} brandColor={brandColor} />
        ) : null}
      </div>
    </AdminShell>
  );
}
