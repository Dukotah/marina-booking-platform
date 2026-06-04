import { Banknote, CreditCard, Percent, Settings2, Tag } from 'lucide-react';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@marina/ui';
import { KpiCard } from '../shell';
import { DataTable, type Column } from '../shell/DataTable';
import { formatNumber, formatUSD } from '../../lib/format';
import type { TaxesFeesReport } from './queries';

export interface TaxesFeesReportViewProps {
  report: TaxesFeesReport;
}

type ConfiguredFee = TaxesFeesReport['configuredFees'][number];

/** Render a fee's value: "8.5%" for percent, "$5.00" for a flat amount (cents). */
function feeValueLabel(fee: ConfiguredFee): string {
  if (fee.type === 'PERCENT') return `${fee.value}%`;
  // FLAT fee `value` is stored in cents (integer-cents convention).
  return formatUSD(Math.round(fee.value));
}

/**
 * Taxes & Fees report: collected tax, processing fees, discounts, and tips for
 * the range, plus the operator's configured fee schedule so the numbers are
 * explainable. All figures come from the tenant-scoped order columns; nothing is
 * recomputed client-side, so it always reconciles with what was charged.
 */
export function TaxesFeesReportView({ report }: TaxesFeesReportViewProps) {
  const { totals } = report;

  const feeColumns: Array<Column<ConfiguredFee>> = [
    {
      id: 'name',
      header: 'Fee',
      cell: (f) => <span className="font-medium text-slate-900">{f.name}</span>,
    },
    {
      id: 'type',
      header: 'Type',
      cell: (f) => (
        <span className="inline-flex items-center gap-1 text-slate-600">
          {f.type === 'PERCENT' ? (
            <Percent className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Banknote className="h-3.5 w-3.5" aria-hidden />
          )}
          {f.type === 'PERCENT' ? 'Percent' : 'Flat'}
        </span>
      ),
    },
    { id: 'value', header: 'Value', align: 'right', cell: (f) => <span className="tabular-nums">{feeValueLabel(f)}</span> },
    { id: 'scope', header: 'Applies to', cell: (f) => <span className="text-slate-600">{f.scope}</span> },
    {
      id: 'enabled',
      header: 'Status',
      align: 'right',
      cell: (f) => (
        <Badge variant={f.enabled ? 'success' : 'outline'}>{f.enabled ? 'Active' : 'Off'}</Badge>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Tax collected" value={formatUSD(totals.taxCents)} icon={Percent} />
        <KpiCard
          label="Processing fees"
          value={formatUSD(totals.processingFeeCents)}
          icon={CreditCard}
        />
        <KpiCard label="Discounts given" value={formatUSD(totals.discountCents)} icon={Tag} />
        <KpiCard label="Tips" value={formatUSD(totals.tipCents)} icon={Banknote} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y divide-slate-100 text-sm">
            <Row label="Taxable base (net of discounts)" value={formatUSD(totals.taxableBaseCents)} />
            <Row label="Tax collected" value={formatUSD(totals.taxCents)} />
            <Row label="Processing fees" value={formatUSD(totals.processingFeeCents)} />
            <Row label="Discounts given" value={`−${formatUSD(totals.discountCents)}`} muted />
            <Row label="Tips" value={formatUSD(totals.tipCents)} />
            <Row label="Orders in range" value={formatNumber(totals.orders)} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center gap-2">
          <Settings2 className="h-4 w-4 text-slate-400" aria-hidden />
          <CardTitle>Configured fees</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={feeColumns}
            rows={report.configuredFees}
            getRowKey={(f) => f.id}
            emptyState={
              <EmptyState
                icon={Settings2}
                title="No fees configured"
                description="Tax and processing fees defined in Settings will appear here."
              />
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
      <dt className="text-slate-500">{label}</dt>
      <dd className={muted ? 'tabular-nums text-slate-500' : 'tabular-nums font-medium text-slate-900'}>
        {value}
      </dd>
    </div>
  );
}
