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
import { resolveSalesView } from '../../components/reports/kinds';
import { ReportTabs } from '../../components/reports/ReportTabs';
import { ReportDateFilter } from '../../components/reports/ReportDateFilter';
import { ReportControls } from '../../components/reports/ReportControls';
import { ExportButton } from '../../components/reports/ExportButton';
import { RevenueReportView } from '../../components/reports/RevenueReportView';
import { SalesReportView } from '../../components/reports/SalesReportView';
import { MerchandiseReportView } from '../../components/reports/MerchandiseReportView';
import { TaxesFeesReportView } from '../../components/reports/TaxesFeesReportView';
import { OccupancyReportView } from '../../components/reports/OccupancyReportView';
import { GiftCardReportView } from '../../components/reports/GiftCardReportView';
import { EndOfDayReportView } from '../../components/reports/EndOfDayReportView';
import { HeadCountReportView } from '../../components/reports/HeadCountReportView';
import { RefundsReportView } from '../../components/reports/RefundsReportView';

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
 * Reports page: revenue, itemized sales, merchandise, taxes & fees, occupancy,
 * gift cards, end-of-day, and head count over a selectable date range, with
 * full-detail CSV export. Every figure is tenant-scoped (RLS) and gated behind
 * `report:read`. Unlike the incumbent, this route never 404s — a
 * missing/invalid report kind falls back to revenue, an unknown range defaults
 * to the last 30 days, and a permission failure renders a clear denied state
 * in-page.
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
          <PageHeader title="Reports" description="Revenue, sales, merchandise, and operations." />
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
  const basis = single(searchParams?.basis);
  const compare = single(searchParams?.compare);
  const activity = single(searchParams?.activity);
  const view = resolveSalesView(single(searchParams?.view));

  const bundle = await getReportsBundle(from, to, basis, compare, activity);
  const { range, brandColor } = bundle;

  return (
    <AdminShell>
      <PageHeader
        title="Reports"
        description="Sales, revenue, merchandise, taxes & fees, occupancy, gift cards, and operations."
        actions={
          <ExportButton
            reportKind={reportKind}
            from={range.from}
            to={range.to}
            basis={bundle.basis}
            compare={bundle.compare}
            activityId={bundle.activityId}
            view={view}
          />
        }
      />

      <div className="flex flex-col gap-6">
        <ReportDateFilter from={range.from} to={range.to} reportKind={reportKind} />
        <ReportTabs active={reportKind} from={range.from} to={range.to} />

        <ReportControls
          reportKind={reportKind}
          basis={bundle.basis}
          compare={bundle.compare}
          activityId={bundle.activityId}
          activities={bundle.activities}
          view={view}
        />

        {reportKind === 'sales' ? <SalesReportView report={bundle.sales} view={view} /> : null}
        {reportKind === 'merchandise' ? (
          <MerchandiseReportView report={bundle.merchandise} />
        ) : null}
        {reportKind === 'revenue' ? (
          <RevenueReportView report={bundle.revenue} brandColor={brandColor} />
        ) : null}
        {reportKind === 'taxes-fees' ? (
          <TaxesFeesReportView report={bundle.taxesFees} />
        ) : null}
        {reportKind === 'occupancy' ? (
          <OccupancyReportView report={bundle.occupancy} brandColor={brandColor} />
        ) : null}
        {reportKind === 'gift-cards' ? (
          <GiftCardReportView report={bundle.giftCards} />
        ) : null}
        {reportKind === 'end-of-day' ? <EndOfDayReportView report={bundle.endOfDay} /> : null}
        {reportKind === 'head-count' ? <HeadCountReportView report={bundle.headCount} /> : null}
        {reportKind === 'refunds' ? <RefundsReportView report={bundle.refunds} /> : null}
      </div>
    </AdminShell>
  );
}
