import {
  Banknote,
  CreditCard,
  Gift,
  HandCoins,
  Receipt,
  RotateCcw,
} from 'lucide-react';
import { PAYMENT_METHOD_LABEL, type PaymentMethodKey } from '@marina/core';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@marina/ui';
import { KpiCard } from '../shell';
import { formatNumber, formatUSD } from '../../lib/format';
import type { EndOfDayReport } from './queries';

export interface EndOfDayReportViewProps {
  report: EndOfDayReport;
}

const METHOD_ICON: Record<PaymentMethodKey, typeof CreditCard> = {
  CARD: CreditCard,
  CASH: Banknote,
  GIFT_CARD: Gift,
  COMP: HandCoins,
};

const CELL = 'px-3 py-2 tabular-nums text-right';
const CELL_LEFT = 'px-3 py-2 text-left';

/** UI row cap for the register tape — the CSV export carries every row. */
const TAPE_LIMIT = 50;

/** Local, readable timestamp for a payment row. */
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * End-of-Day / register summary: everything keyed by when the MONEY moved
 * (payment processed date) — the drawer-count view. Cash net is the expected
 * drawer movement; refunds are itemized so nothing "disappears" between the
 * register and the bank. Pick a single day in the date filter for a classic
 * end-of-day close; a longer range gives a period summary.
 */
export function EndOfDayReportView({ report }: EndOfDayReportViewProps) {
  const cash = report.payments.byMethod.find((m) => m.method === 'CASH');
  const card = report.payments.byMethod.find((m) => m.method === 'CARD');

  if (report.payments.totals.count === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title="No payments in this range"
        description="Tenders appear here on the day the money moved (payment processed date)."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Net collected"
          value={formatUSD(report.payments.totals.netCents)}
          icon={Receipt}
        />
        <KpiCard label="Cash drawer (net)" value={formatUSD(cash?.netCents ?? 0)} icon={Banknote} />
        <KpiCard label="Card (net)" value={formatUSD(card?.netCents ?? 0)} icon={CreditCard} />
        <KpiCard
          label="Refunded"
          value={formatUSD(report.payments.totals.refundedCents)}
          icon={RotateCcw}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Tenders by method</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-xs font-medium uppercase tracking-wide text-ink-muted">
                  <th className={CELL_LEFT}>Method</th>
                  <th className={CELL}>Count</th>
                  <th className={CELL}>Collected</th>
                  <th className={CELL}>Refunded</th>
                  <th className={CELL}>Net</th>
                </tr>
              </thead>
              <tbody>
                {report.payments.byMethod.map((m) => {
                  const Icon = METHOD_ICON[m.method];
                  return (
                    <tr key={m.method} className="border-t border-line">
                      <td className={`${CELL_LEFT}`}>
                        <span className="flex items-center gap-2 font-medium text-ink-body">
                          <Icon className="h-4 w-4 text-ink-muted" aria-hidden />
                          {PAYMENT_METHOD_LABEL[m.method]}
                        </span>
                      </td>
                      <td className={`${CELL} text-ink-body`}>{formatNumber(m.count)}</td>
                      <td className={`${CELL} text-ink-body`}>{formatUSD(m.collectedCents)}</td>
                      <td className={`${CELL} text-ink-muted`}>
                        {m.refundedCents ? `−${formatUSD(m.refundedCents)}` : '—'}
                      </td>
                      <td className={`${CELL} font-medium text-ink`}>{formatUSD(m.netCents)}</td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-line font-semibold text-ink">
                  <td className={CELL_LEFT}>All methods</td>
                  <td className={CELL}>{formatNumber(report.payments.totals.count)}</td>
                  <td className={CELL}>{formatUSD(report.payments.totals.collectedCents)}</td>
                  <td className={CELL}>
                    {report.payments.totals.refundedCents
                      ? `−${formatUSD(report.payments.totals.refundedCents)}`
                      : '—'}
                  </td>
                  <td className={CELL}>{formatUSD(report.payments.totals.netCents)}</td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Refunds</CardTitle>
          </CardHeader>
          <CardContent>
            {report.refunds.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-muted">No refunds in this range.</p>
            ) : (
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line text-xs font-medium uppercase tracking-wide text-ink-muted">
                    <th className={CELL_LEFT}>When</th>
                    <th className={CELL_LEFT}>Order</th>
                    <th className={CELL_LEFT}>Method</th>
                    <th className={CELL}>Paid</th>
                    <th className={CELL}>Refunded</th>
                  </tr>
                </thead>
                <tbody>
                  {report.refunds.map((r, i) => (
                    <tr key={`${r.orderNumber}-${i}`} className="border-t border-line">
                      <td className={`${CELL_LEFT} tabular-nums text-ink-muted`}>
                        {fmtWhen(r.processedAt)}
                      </td>
                      <td className={`${CELL_LEFT} tabular-nums text-ink-body`}>{r.orderNumber}</td>
                      <td className={`${CELL_LEFT} text-ink-body`}>
                        {PAYMENT_METHOD_LABEL[r.method as PaymentMethodKey] ?? r.method}
                      </td>
                      <td className={`${CELL} text-ink-body`}>{formatUSD(r.amountCents)}</td>
                      <td className={`${CELL} font-medium text-red-600`}>
                        −{formatUSD(r.refundedCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Register tape</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-medium uppercase tracking-wide text-ink-muted">
                <th className={CELL_LEFT}>When</th>
                <th className={CELL_LEFT}>Order</th>
                <th className={CELL_LEFT}>Method</th>
                <th className={CELL}>Amount</th>
                <th className={CELL}>Refunded</th>
                <th className={CELL}>Net</th>
              </tr>
            </thead>
            <tbody>
              {report.transactions.slice(0, TAPE_LIMIT).map((t, i) => (
                <tr key={`${t.orderNumber}-${i}`} className="border-t border-line">
                  <td className={`${CELL_LEFT} tabular-nums text-ink-muted`}>{fmtWhen(t.processedAt)}</td>
                  <td className={`${CELL_LEFT} tabular-nums text-ink-body`}>{t.orderNumber}</td>
                  <td className={`${CELL_LEFT} text-ink-body`}>
                    {PAYMENT_METHOD_LABEL[t.method as PaymentMethodKey] ?? t.method}
                    {t.manuallyKeyed ? (
                      <span className="ml-1.5 text-xs text-ink-muted">(keyed)</span>
                    ) : null}
                  </td>
                  <td className={`${CELL} text-ink-body`}>{formatUSD(t.amountCents)}</td>
                  <td className={`${CELL} text-ink-muted`}>
                    {t.refundedCents ? `−${formatUSD(t.refundedCents)}` : '—'}
                  </td>
                  <td className={`${CELL} font-medium text-ink`}>{formatUSD(t.netCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.transactions.length > TAPE_LIMIT ? (
            <p className="mt-2 text-xs text-ink-muted">
              Showing the latest {TAPE_LIMIT} of {formatNumber(report.transactions.length)} tenders —
              Export CSV includes every one.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
