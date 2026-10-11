import { Receipt, Tag, Compass } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@marina/ui';
import { KpiCard } from '../shell';
import { formatNumber, formatUSD } from '../../lib/format';
import type { RefundsTabReport } from './queries';

export interface RefundsReportViewProps {
  report: RefundsTabReport;
}

/**
 * Refunds-by-reason report: total refunded in range up top, then a breakdown by
 * the reason captured on each refund and, in parallel, by the activity the
 * refunded order belonged to. The reason is read straight off the refund event
 * metadata (no schema change). Tenant-scoped; degrades to clean zeros when the
 * period had no refunds.
 */
export function RefundsReportView({ report }: RefundsReportViewProps) {
  const hasData = report.totals.count > 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <KpiCard label="Refunded (in range)" value={formatUSD(report.totals.amountCents)} icon={Receipt} />
        <KpiCard label="Refunds" value={formatNumber(report.totals.count)} icon={Tag} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By reason</CardTitle>
          </CardHeader>
          <CardContent>
            {!hasData ? (
              <EmptyState
                icon={Tag}
                title="No refunds in this range"
                description="Refunds appear here grouped by the reason staff recorded at refund time."
              />
            ) : (
              <ul className="flex flex-col divide-y divide-line text-sm">
                {report.byReason.map((r) => (
                  <li
                    key={r.reason}
                    className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-ink">{r.reason}</span>
                      <span className="text-xs text-ink-muted">
                        {formatNumber(r.count)} refund{r.count === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span className="tabular-nums font-medium text-ink">
                      {formatUSD(r.amountCents)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>By activity</CardTitle>
          </CardHeader>
          <CardContent>
            {!hasData ? (
              <EmptyState
                icon={Compass}
                title="No refunds in this range"
                description="Refunds appear here grouped by the activity the refunded order belonged to."
              />
            ) : (
              <ul className="flex flex-col divide-y divide-line text-sm">
                {report.byActivity.map((a) => (
                  <li
                    key={a.activityId ?? '__none__'}
                    className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-ink">{a.activityName}</span>
                      <span className="text-xs text-ink-muted">
                        {formatNumber(a.count)} refund{a.count === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span className="tabular-nums font-medium text-ink">
                      {formatUSD(a.amountCents)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
