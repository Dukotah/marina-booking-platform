import {
  Banknote,
  CreditCard,
  Gift,
  HandCoins,
  Package,
  Receipt,
  ShoppingBag,
  TrendingUp,
} from 'lucide-react';
import { PAYMENT_METHOD_LABEL, type PaymentMethodKey } from '@marina/core';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@marina/ui';
import { KpiCard } from '../shell';
import { formatNumber, formatUSD } from '../../lib/format';
import type { Delta } from '@marina/core';
import type { SalesReport } from './queries';

export interface SalesReportViewProps {
  report: SalesReport;
}

/** A finite ratio for KpiCard, or undefined when the delta base was zero. */
function deltaRatio(delta: Delta | undefined): number | undefined {
  if (!delta || delta.ratio === null || !Number.isFinite(delta.ratio)) return undefined;
  return delta.ratio;
}

/** Icon per payment method. */
const METHOD_ICON: Record<PaymentMethodKey, typeof CreditCard> = {
  CARD: CreditCard,
  CASH: Banknote,
  GIFT_CARD: Gift,
  COMP: HandCoins,
};

/**
 * Sales report: the money breakdown Singenuity leads with — gross sales, taxes &
 * fees, tips, merchandise, packages — plus a payments-by-method table. Honors the
 * active date basis (order vs appointment) and, in comparison mode, shows deltas
 * vs the prior period on the headline KPIs. Every figure is tenant-scoped; empty
 * ranges render clean zeros, never a broken page.
 */
export function SalesReportView({ report }: SalesReportViewProps) {
  const { totals, comparison } = report;
  const cmp = comparison?.deltas;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Gross sales"
          value={formatUSD(totals.grossSalesCents)}
          icon={TrendingUp}
          deltaRatio={deltaRatio(cmp?.grossSalesCents)}
          deltaLabel="vs prev period"
        />
        <KpiCard
          label="Taxes & fees"
          value={formatUSD(totals.taxesAndFeesCents)}
          icon={Receipt}
          deltaRatio={deltaRatio(cmp?.taxesAndFeesCents)}
          deltaLabel="vs prev period"
        />
        <KpiCard
          label="Tips"
          value={formatUSD(totals.tipCents)}
          icon={HandCoins}
          deltaRatio={deltaRatio(cmp?.tipCents)}
          deltaLabel="vs prev period"
        />
        <KpiCard
          label="Orders"
          value={formatNumber(totals.orders)}
          icon={ShoppingBag}
          deltaRatio={deltaRatio(cmp?.orders)}
          deltaLabel="vs prev period"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Sales breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-slate-100 text-sm">
              <BreakdownRow label="Gross sales" value={formatUSD(totals.grossSalesCents)} strong />
              <BreakdownRow label="Subtotal" value={formatUSD(totals.subtotalCents)} />
              <BreakdownRow label="Discounts" value={`−${formatUSD(totals.discountCents)}`} muted />
              <BreakdownRow label="Net sales" value={formatUSD(totals.netSalesCents)} />
              <BreakdownRow label="Tax" value={formatUSD(totals.taxCents)} />
              <BreakdownRow label="Processing fees" value={formatUSD(totals.processingFeeCents)} />
              <BreakdownRow label="Taxes & fees" value={formatUSD(totals.taxesAndFeesCents)} />
              <BreakdownRow label="Tips" value={formatUSD(totals.tipCents)} />
              <BreakdownRow
                label="Merchandise"
                value={report.merchandiseCents === null ? 'Not tracked' : formatUSD(report.merchandiseCents)}
                icon={ShoppingBag}
                muted={report.merchandiseCents === null}
              />
              <BreakdownRow
                label="Packages"
                value={report.packagesCents === null ? 'Not available' : formatUSD(report.packagesCents)}
                icon={Package}
                muted={report.packagesCents === null}
              />
            </dl>
            {report.merchandiseCents === null ? (
              <p className="mt-3 text-xs text-slate-400">
                Merchandise is included in gross sales but not itemized in the current data model, so it
                is not broken out separately. Packages are not yet a feature.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payments by method</CardTitle>
          </CardHeader>
          <CardContent>
            {report.payments.totals.count === 0 ? (
              <EmptyState
                icon={CreditCard}
                title="No payments in this range"
                description="Card, cash, gift-card, and comp tenders appear here once orders are paid."
              />
            ) : (
              <ul className="flex flex-col divide-y divide-slate-100 text-sm">
                {report.payments.byMethod.map((m) => {
                  const Icon = METHOD_ICON[m.method];
                  return (
                    <li
                      key={m.method}
                      className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      <span className="flex min-w-0 items-center gap-2 text-slate-700">
                        <Icon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                        <span className="truncate font-medium">
                          {PAYMENT_METHOD_LABEL[m.method]}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-baseline gap-3">
                        <span className="text-xs text-slate-400">
                          {formatNumber(m.count)} payment{m.count === 1 ? '' : 's'}
                        </span>
                        <span className="tabular-nums font-medium text-slate-900">
                          {formatUSD(m.netCents)}
                        </span>
                      </span>
                    </li>
                  );
                })}
                <li className="flex items-center justify-between gap-3 py-3 last:pb-0">
                  <span className="font-semibold text-slate-900">Net collected</span>
                  <span className="tabular-nums font-semibold text-slate-900">
                    {formatUSD(report.payments.totals.netCents)}
                  </span>
                </li>
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {comparison ? (
        <Card>
          <CardHeader>
            <CardTitle>
              Comparison — {comparison.range.from} to {comparison.range.to}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <CompareStat label="Gross sales" current={formatUSD(totals.grossSalesCents)} delta={cmp!.grossSalesCents} />
              <CompareStat label="Taxes & fees" current={formatUSD(totals.taxesAndFeesCents)} delta={cmp!.taxesAndFeesCents} />
              <CompareStat label="Tips" current={formatUSD(totals.tipCents)} delta={cmp!.tipCents} />
              <CompareStat label="Net sales" current={formatUSD(totals.netSalesCents)} delta={cmp!.netSalesCents} />
            </dl>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function CompareStat({
  label,
  current,
  delta,
}: {
  label: string;
  current: string;
  delta: Delta;
}) {
  const up = delta.direction === 'up';
  const down = delta.direction === 'down';
  const changeLabel =
    delta.ratio === null
      ? delta.absolute === 0
        ? 'no change'
        : 'new'
      : `${delta.ratio > 0 ? '+' : ''}${(delta.ratio * 100).toFixed(1)}%`;
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-slate-100 p-3">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-slate-900">{current}</dd>
      <span
        className={
          up
            ? 'text-xs font-medium text-emerald-600'
            : down
              ? 'text-xs font-medium text-red-600'
              : 'text-xs font-medium text-slate-400'
        }
      >
        {changeLabel} vs prev
      </span>
    </div>
  );
}

function BreakdownRow({
  label,
  value,
  muted,
  strong,
  icon: Icon,
}: {
  label: string;
  value: string;
  muted?: boolean;
  strong?: boolean;
  icon?: typeof ShoppingBag;
}) {
  return (
    <div className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
      <dt
        className={
          strong ? 'flex items-center gap-1.5 font-semibold text-slate-900' : 'flex items-center gap-1.5 text-slate-500'
        }
      >
        {Icon ? <Icon className="h-3.5 w-3.5 text-slate-400" aria-hidden /> : null}
        {label}
      </dt>
      <dd
        className={
          strong
            ? 'tabular-nums text-base font-semibold text-slate-900'
            : muted
              ? 'tabular-nums text-slate-400'
              : 'tabular-nums font-medium text-slate-900'
        }
      >
        {value}
      </dd>
    </div>
  );
}
