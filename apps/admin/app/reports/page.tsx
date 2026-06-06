import { AlertTriangle } from 'lucide-react';
import { AuthorizationError } from '@marina/auth';
import { EmptyState } from '@marina/ui';
import { AdminShell } from '../../components/shell/AdminShell';
import { PageHeader } from '../../components/shell';
import { requirePermission } from '../../lib/session';
import {
  getReportsBundle,
  resolveReportKind,
  resolveRange,
  type ReportKind,
} from '../../components/reports/queries';
import { ReportTabs } from '../../components/reports/ReportTabs';
import { ReportDateFilter } from '../../components/reports/ReportDateFilter';
import { ExportButton } from '../../components/reports/ExportButton';
import { RevenueReportView } from '../../components/reports/RevenueReportView';
import { TaxesFeesReportView } from '../../components/reports/TaxesFeesReportView';
import { OccupancyReportView } from '../../components/reports/OccupancyReportView';
import {
  ByLocationReportView,
  type LocationReport,
} from '../../components/reports/ByLocationReportView';
import {
  TransactionsReportView,
  type TransactionsReport,
} from '../../components/reports/TransactionsReportView';
import { apiGet } from '../../lib/apiClient';

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
 * Reports page: revenue, taxes & fees, occupancy, by-location, and accounting
 * transactions over a selectable date range, with CSV export. Every figure is
 * tenant-scoped (RLS) and gated behind `report:read`.
 *
 * The original three kinds read the DB directly via queries.ts. The two new
 * kinds (by-location, transactions) fetch from the API — those aggregations live
 * there (D-020/D-021) and must not be re-implemented here.
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
          <PageHeader
            title="Reports"
            description="Revenue, taxes & fees, occupancy, and accounting."
          />
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

  // -------------------------------------------------------------------------
  // API-sourced kinds: by-location and transactions
  // These fetch from the Hono API (GET /api/reports/by-location|transactions)
  // so the aggregation logic stays in one place (D-020/D-021).
  // -------------------------------------------------------------------------
  if (reportKind === 'by-location') {
    const { range } = resolveRange(from, to);
    const { report } = await apiGet<{ report: LocationReport }>('/api/reports/by-location', {
      from: range.from,
      to: range.to,
    });

    return (
      <AdminShell>
        <PageHeader
          title="Reports"
          description="Revenue, taxes & fees, occupancy, and accounting."
          actions={<ExportButton reportKind={reportKind} from={range.from} to={range.to} />}
        />
        <div className="flex flex-col gap-6">
          <ReportDateFilter from={range.from} to={range.to} reportKind={reportKind} />
          <ReportTabs active={reportKind} from={range.from} to={range.to} />
          <ByLocationReportView report={report} />
        </div>
      </AdminShell>
    );
  }

  if (reportKind === 'transactions') {
    const { range } = resolveRange(from, to);
    const { report } = await apiGet<{ report: TransactionsReport }>('/api/reports/transactions', {
      from: range.from,
      to: range.to,
    });

    return (
      <AdminShell>
        <PageHeader
          title="Reports"
          description="Revenue, taxes & fees, occupancy, and accounting."
          actions={<ExportButton reportKind={reportKind} from={range.from} to={range.to} />}
        />
        <div className="flex flex-col gap-6">
          <ReportDateFilter from={range.from} to={range.to} reportKind={reportKind} />
          <ReportTabs active={reportKind} from={range.from} to={range.to} />
          <TransactionsReportView report={report} />
        </div>
      </AdminShell>
    );
  }

  // -------------------------------------------------------------------------
  // DB-sourced kinds: revenue, taxes-fees, occupancy (unchanged)
  // -------------------------------------------------------------------------
  const bundle = await getReportsBundle(from, to);
  const { range, brandColor } = bundle;

  return (
    <AdminShell>
      <PageHeader
        title="Reports"
        description="Revenue, taxes & fees, occupancy, and accounting."
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
