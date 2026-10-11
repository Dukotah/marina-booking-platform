import { Gift, Wallet, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@marina/ui';
import { KpiCard } from '../shell';
import { formatNumber, formatUSD } from '../../lib/format';
import type { GiftCardReport } from './queries';

export interface GiftCardReportViewProps {
  report: GiftCardReport;
}

/** Badge tone per gift-card status. */
function statusVariant(status: string): 'success' | 'warning' | 'outline' {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'REDEEMED':
      return 'outline';
    default:
      return 'warning';
  }
}

/**
 * Gift-card report: outstanding liability (money owed to cardholders) up top, the
 * issued/redeemed flow for the selected range, and a snapshot of the card book by
 * status. Liability is the ACTIVE-balance sum (a point-in-time figure), while
 * issued/redeemed are windowed. All tenant-scoped; degrades to clean zeros.
 */
export function GiftCardReportView({ report }: GiftCardReportViewProps) {
  const hasBook = report.byStatus.some((s) => s.count > 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard label="Outstanding liability" value={formatUSD(report.liabilityCents)} icon={Wallet} />
        <KpiCard
          label="Issued (in range)"
          value={formatUSD(report.issued.amountCents)}
          icon={ArrowUpCircle}
        />
        <KpiCard
          label="Redeemed (in range)"
          value={formatUSD(report.redeemed.amountCents)}
          icon={ArrowDownCircle}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Issued vs redeemed</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-line text-sm">
              <FlowRow
                label="Issued"
                count={report.issued.count}
                value={formatUSD(report.issued.amountCents)}
              />
              <FlowRow
                label="Redeemed"
                count={report.redeemed.count}
                value={formatUSD(report.redeemed.amountCents)}
              />
              <FlowRow
                label="Outstanding liability"
                value={formatUSD(report.liabilityCents)}
                strong
              />
            </dl>
            <p className="mt-3 text-xs text-ink-muted">
              Liability is the current sum of all active card balances (point-in-time). Issued and
              redeemed cover the selected date range.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Card book by status</CardTitle>
          </CardHeader>
          <CardContent>
            {!hasBook ? (
              <EmptyState
                icon={Gift}
                title="No gift cards yet"
                description="Issued gift cards appear here, grouped by status with their outstanding balance."
              />
            ) : (
              <ul className="flex flex-col divide-y divide-line text-sm">
                {report.byStatus.map((s) => (
                  <li
                    key={s.status}
                    className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <span className="flex items-center gap-2">
                      <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                      <span className="text-xs text-ink-muted">
                        {formatNumber(s.count)} card{s.count === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span className="tabular-nums font-medium text-ink">
                      {formatUSD(s.balanceCents)}
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

function FlowRow({
  label,
  count,
  value,
  strong,
}: {
  label: string;
  count?: number;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
      <dt className={strong ? 'font-semibold text-ink' : 'text-ink-muted'}>{label}</dt>
      <dd className="flex items-baseline gap-3">
        {typeof count === 'number' ? (
          <span className="text-xs text-ink-muted">
            {formatNumber(count)} card{count === 1 ? '' : 's'}
          </span>
        ) : null}
        <span
          className={
            strong
              ? 'tabular-nums text-base font-semibold text-ink'
              : 'tabular-nums font-medium text-ink'
          }
        >
          {value}
        </span>
      </dd>
    </div>
  );
}
