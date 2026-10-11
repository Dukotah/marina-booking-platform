import Link from 'next/link';
import {
  Banknote,
  CheckCircle2,
  CreditCard,
  Gift,
  HandCoins,
  Receipt,
  ShoppingBag,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react';
import {
  PAYMENT_METHOD_LABEL,
  type PaymentMethodKey,
  type Delta,
  type Reconciliation,
} from '@marina/core';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@marina/ui';
import { KpiCard } from '../shell';
import { formatNumber, formatUSD } from '../../lib/format';
import type { SalesView } from './kinds';
import type { SalesReport } from './queries';

export interface SalesReportViewProps {
  report: SalesReport;
  view: SalesView;
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
 * Sales report with three depths:
 *  - Summary: the money breakdown Singenuity leads with — gross, taxes & fees,
 *    tips, real activity/package/merchandise/charge subtotals — plus payments
 *    by method and (in comparison mode) deltas vs the prior period.
 *  - Items: one row per distinct activity / package / merchandise item /
 *    charge, with per-group subtotals and a combined grand total.
 *  - Details: every allocated sale line, traceable to its order.
 * Every view reconciles with the others by construction (order-level money is
 * allocated with an exact largest-remainder split), and the reconciliation
 * badge PROVES it on real data instead of asking for trust.
 */
export function SalesReportView({ report, view }: SalesReportViewProps) {
  if (view === 'items') return <ItemsView report={report} />;
  if (view === 'details') return <DetailsView report={report} />;
  return <SummaryView report={report} />;
}

// ---------------------------------------------------------------------------
// Reconciliation badge — the trust feature
// ---------------------------------------------------------------------------

function ReconciliationBadge({ reconciliation }: { reconciliation: Reconciliation }) {
  if (reconciliation.ok) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600"
        title="Itemized lines, discounts, taxes, and charges sum exactly to the summary totals."
      >
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
        Reconciled
      </span>
    );
  }
  const failing = reconciliation.checks.filter((c) => !c.ok);
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-medium text-amber-600"
      title={failing
        .map((c) => `${c.name}: expected ${formatUSD(c.expectedCents)}, got ${formatUSD(c.actualCents)}`)
        .join('\n')}
    >
      <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
      {formatUSD(Math.abs(failing.reduce((s, c) => s + c.diffCents, 0)))} unreconciled
    </span>
  );
}

/** Expanded check list, shown when reconciliation fails (never hide a discrepancy). */
function ReconciliationDetail({ reconciliation }: { reconciliation: Reconciliation }) {
  if (reconciliation.ok) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TriangleAlert className="h-4 w-4 text-amber-600" aria-hidden />
          Reconciliation checks
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-xs text-ink-muted">
          Some line items don&apos;t sum to the order totals — usually orders recorded before
          line-level tracking existed. The summary totals are authoritative.
        </p>
        <ul className="divide-y divide-line text-sm">
          {reconciliation.checks.map((c) => (
            <li key={c.name} className="flex items-center justify-between gap-3 py-2">
              <span className={c.ok ? 'text-ink-muted' : 'font-medium text-amber-700'}>{c.name}</span>
              <span className="tabular-nums text-ink-body">
                {c.ok ? '✓' : `${formatUSD(c.actualCents)} vs ${formatUSD(c.expectedCents)}`}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Summary view
// ---------------------------------------------------------------------------

function SummaryView({ report }: { report: SalesReport }) {
  const { totals, comparison } = report;
  const cmp = comparison?.deltas;
  const merchParams = new URLSearchParams({
    report: 'merchandise',
    from: report.range.from,
    to: report.range.to,
  });

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
            <CardTitle className="flex items-center justify-between gap-3">
              Sales breakdown
              <ReconciliationBadge reconciliation={report.itemized.reconciliation} />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-line text-sm">
              <BreakdownRow label="Activities" value={formatUSD(report.activitiesCents)} />
              <BreakdownRow label="Packages" value={formatUSD(report.packagesCents)} />
              <BreakdownRow
                label={
                  <Link
                    href={`/reports?${merchParams.toString()}`}
                    className="underline decoration-line underline-offset-2 hover:text-ink"
                  >
                    Merchandise
                  </Link>
                }
                icon={ShoppingBag}
                value={formatUSD(report.merchandiseCents)}
              />
              <BreakdownRow label="Subtotal" value={formatUSD(totals.subtotalCents)} strong />
              <BreakdownRow label="Discounts" value={`−${formatUSD(totals.discountCents)}`} muted />
              <BreakdownRow label="Net sales" value={formatUSD(totals.netSalesCents)} />
              <BreakdownRow label="Tax" value={formatUSD(totals.taxCents)} />
              <BreakdownRow label="Processing fees" value={formatUSD(totals.processingFeeCents)} />
              <BreakdownRow label="Tips" value={formatUSD(totals.tipCents)} />
              <BreakdownRow label="Charges (fuel, cleaning, damage)" value={formatUSD(report.chargesCents)} />
              <BreakdownRow label="Gross sales" value={formatUSD(totals.grossSalesCents)} strong />
            </dl>
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
              <ul className="flex flex-col divide-y divide-line text-sm">
                {report.payments.byMethod.map((m) => {
                  const Icon = METHOD_ICON[m.method];
                  return (
                    <li
                      key={m.method}
                      className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      <span className="flex min-w-0 items-center gap-2 text-ink-body">
                        <Icon className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
                        <span className="truncate font-medium">
                          {PAYMENT_METHOD_LABEL[m.method]}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-baseline gap-3">
                        <span className="text-xs text-ink-muted">
                          {formatNumber(m.count)} payment{m.count === 1 ? '' : 's'}
                        </span>
                        <span className="tabular-nums font-medium text-ink">
                          {formatUSD(m.netCents)}
                        </span>
                      </span>
                    </li>
                  );
                })}
                <li className="flex items-center justify-between gap-3 py-3 last:pb-0">
                  <span className="font-semibold text-ink">Net collected</span>
                  <span className="tabular-nums font-semibold text-ink">
                    {formatUSD(report.payments.totals.netCents)}
                  </span>
                </li>
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <ReconciliationDetail reconciliation={report.itemized.reconciliation} />

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

// ---------------------------------------------------------------------------
// Items view (aggregated line items with group subtotals)
// ---------------------------------------------------------------------------

const CELL = 'px-3 py-2 tabular-nums text-right';
const CELL_LEFT = 'px-3 py-2 text-left';

function ItemsView({ report }: { report: SalesReport }) {
  const { itemized } = report;

  if (itemized.groups.length === 0) {
    return (
      <EmptyState
        icon={ShoppingBag}
        title="No sales in this range"
        description="Line items appear here once orders are placed in the selected window."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-3">
            Itemized sales
            <ReconciliationBadge reconciliation={itemized.reconciliation} />
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-medium uppercase tracking-wide text-ink-muted">
                <th className={CELL_LEFT}>Item</th>
                <th className={CELL}>Qty</th>
                <th className={CELL}>Gross</th>
                <th className={CELL}>Discounts</th>
                <th className={CELL}>Net</th>
                <th className={CELL}>Taxes & fees</th>
                <th className={CELL}>Total</th>
              </tr>
            </thead>
            <tbody>
              {itemized.groups.map((group) => (
                <GroupRows key={group.key} group={group} />
              ))}
              <tr className="border-t border-line">
                <td className={`${CELL_LEFT} text-ink-muted`}>Tips</td>
                <td className={CELL} />
                <td className={CELL} />
                <td className={CELL} />
                <td className={CELL} />
                <td className={CELL} />
                <td className={`${CELL} text-ink-body`}>{formatUSD(itemized.tipCents)}</td>
              </tr>
              <tr className="border-t-2 border-line font-semibold text-ink">
                <td className={CELL_LEFT}>Grand total</td>
                <td className={CELL}>{formatNumber(itemized.totals.quantity)}</td>
                <td className={CELL}>{formatUSD(itemized.totals.grossCents)}</td>
                <td className={CELL}>−{formatUSD(itemized.totals.discountCents)}</td>
                <td className={CELL}>{formatUSD(itemized.totals.netCents)}</td>
                <td className={CELL}>{formatUSD(itemized.totals.taxCents)}</td>
                <td className={CELL}>{formatUSD(itemized.grandTotalCents)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-muted">
            Order-level discounts, taxes, and fees are allocated across line items by value
            (exact to the cent). Grand total includes tips.
          </p>
        </CardContent>
      </Card>

      <ReconciliationDetail reconciliation={itemized.reconciliation} />
    </div>
  );
}

function GroupRows({ group }: { group: SalesReport['itemized']['groups'][number] }) {
  return (
    <>
      <tr>
        <td
          colSpan={7}
          className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-ink-muted"
        >
          {group.label}
        </td>
      </tr>
      {group.rows.map((row) => (
        <tr key={row.itemKey} className="border-t border-line">
          <td className={CELL_LEFT}>
            <span className="font-medium text-ink">{row.label}</span>
            {row.sublabel ? <span className="ml-2 text-xs text-ink-muted">{row.sublabel}</span> : null}
          </td>
          <td className={`${CELL} text-ink-body`}>{formatNumber(row.quantity)}</td>
          <td className={`${CELL} text-ink-body`}>{formatUSD(row.grossCents)}</td>
          <td className={`${CELL} text-ink-muted`}>
            {row.discountCents ? `−${formatUSD(row.discountCents)}` : '—'}
          </td>
          <td className={`${CELL} text-ink-body`}>{formatUSD(row.netCents)}</td>
          <td className={`${CELL} text-ink-body`}>{formatUSD(row.taxCents)}</td>
          <td className={`${CELL} font-medium text-ink`}>{formatUSD(row.totalCents)}</td>
        </tr>
      ))}
      <tr className="border-t border-line bg-surface-muted font-medium text-ink">
        <td className={CELL_LEFT}>{group.label} total</td>
        <td className={CELL}>{formatNumber(group.totals.quantity)}</td>
        <td className={CELL}>{formatUSD(group.totals.grossCents)}</td>
        <td className={CELL}>
          {group.totals.discountCents ? `−${formatUSD(group.totals.discountCents)}` : '—'}
        </td>
        <td className={CELL}>{formatUSD(group.totals.netCents)}</td>
        <td className={CELL}>{formatUSD(group.totals.taxCents)}</td>
        <td className={CELL}>{formatUSD(group.totals.totalCents)}</td>
      </tr>
    </>
  );
}

// ---------------------------------------------------------------------------
// Details view (every allocated line)
// ---------------------------------------------------------------------------

/** UI row cap — the CSV export always carries every line. */
const DETAILS_LIMIT = 200;

function DetailsView({ report }: { report: SalesReport }) {
  const rows = report.details;

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title="No sale lines in this range"
        description="Line-level detail appears here once orders are placed in the selected window."
      />
    );
  }

  const visible = rows.slice(0, DETAILS_LIMIT);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3">
          Sale line detail
          <ReconciliationBadge reconciliation={report.itemized.reconciliation} />
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-xs font-medium uppercase tracking-wide text-ink-muted">
              <th className={CELL_LEFT}>Date</th>
              <th className={CELL_LEFT}>Order</th>
              <th className={CELL_LEFT}>Item</th>
              <th className={CELL}>Qty</th>
              <th className={CELL}>Unit</th>
              <th className={CELL}>Gross</th>
              <th className={CELL}>Discounts</th>
              <th className={CELL}>Net</th>
              <th className={CELL}>Taxes & fees</th>
              <th className={CELL}>Total</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((l, i) => (
              <tr key={`${l.orderId}-${l.itemKey}-${i}`} className="border-t border-line">
                <td className={`${CELL_LEFT} tabular-nums text-ink-muted`}>{l.date}</td>
                <td className={CELL_LEFT}>
                  <Link
                    href={`/orders/${l.orderId}`}
                    className="tabular-nums text-ink-body underline decoration-line underline-offset-2 hover:text-ink"
                  >
                    {l.orderNumber}
                  </Link>
                </td>
                <td className={CELL_LEFT}>
                  <span className="font-medium text-ink">{l.label}</span>
                  {l.sublabel ? <span className="ml-2 text-xs text-ink-muted">{l.sublabel}</span> : null}
                </td>
                <td className={`${CELL} text-ink-body`}>{formatNumber(l.quantity)}</td>
                <td className={`${CELL} text-ink-muted`}>
                  {l.unitPriceCents === null ? '—' : formatUSD(l.unitPriceCents)}
                </td>
                <td className={`${CELL} text-ink-body`}>{formatUSD(l.grossCents)}</td>
                <td className={`${CELL} text-ink-muted`}>
                  {l.discountCents ? `−${formatUSD(l.discountCents)}` : '—'}
                </td>
                <td className={`${CELL} text-ink-body`}>{formatUSD(l.netCents)}</td>
                <td className={`${CELL} text-ink-body`}>{formatUSD(l.taxCents)}</td>
                <td className={`${CELL} font-medium text-ink`}>{formatUSD(l.totalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > DETAILS_LIMIT ? (
          <p className="mt-2 text-xs text-ink-muted">
            Showing the first {DETAILS_LIMIT} of {formatNumber(rows.length)} lines — Export CSV
            includes every line.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

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
    <div className="flex flex-col gap-1 rounded-lg border border-line p-3">
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-ink">{current}</dd>
      <span
        className={
          up
            ? 'text-xs font-medium text-emerald-600'
            : down
              ? 'text-xs font-medium text-red-600'
              : 'text-xs font-medium text-ink-muted'
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
  label: React.ReactNode;
  value: string;
  muted?: boolean;
  strong?: boolean;
  icon?: typeof ShoppingBag;
}) {
  return (
    <div className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
      <dt
        className={
          strong ? 'flex items-center gap-1.5 font-semibold text-ink' : 'flex items-center gap-1.5 text-ink-muted'
        }
      >
        {Icon ? <Icon className="h-3.5 w-3.5 text-ink-muted" aria-hidden /> : null}
        {label}
      </dt>
      <dd
        className={
          strong
            ? 'tabular-nums text-base font-semibold text-ink'
            : muted
              ? 'tabular-nums text-ink-muted'
              : 'tabular-nums font-medium text-ink'
        }
      >
        {value}
      </dd>
    </div>
  );
}
