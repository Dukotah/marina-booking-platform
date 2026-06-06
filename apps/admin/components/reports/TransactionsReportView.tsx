import { CreditCard, DollarSign, Hash, RotateCcw } from 'lucide-react';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@marina/ui';
import { KpiCard } from '../shell';
import { DataTable, type Column } from '../shell/DataTable';
import { formatDate, formatDateTime, formatNumber, formatUSD } from '../../lib/format';

/**
 * Shapes returned by GET /api/reports/transactions.
 * Money is integer cents. `date` is an ISO-8601 string (processed_at).
 * A refund advances `refundedCents` on the originating Payment row — there are no
 * standalone refund-transaction entities — so netCents = grossCents − refundedCents.
 * D-021.
 */
export interface TransactionRow {
  paymentId: string;
  date: string; // ISO-8601 (processed_at)
  orderNumber: string;
  customerName: string;
  method: string; // CARD | CASH | GIFT_CARD | COMP
  processor: string; // STRIPE | SQUARE
  processorTransactionId: string | null;
  status: string;
  grossCents: number;
  refundedCents: number;
  netCents: number;
  manuallyKeyed: boolean;
}

export interface MethodTotal {
  method: string;
  count: number;
  grossCents: number;
  refundedCents: number;
  netCents: number;
}

export interface TransactionsReport {
  from: string;
  to: string;
  count: number;
  totalGrossCents: number;
  totalRefundedCents: number;
  totalNetCents: number;
  byMethod: MethodTotal[];
  transactions: TransactionRow[];
}

export interface TransactionsReportViewProps {
  report: TransactionsReport;
}

/** Badge color mapping for payment method. */
function methodVariant(method: string): 'default' | 'outline' | 'success' | 'warning' {
  switch (method.toUpperCase()) {
    case 'CARD':
      return 'default';
    case 'CASH':
      return 'success';
    case 'GIFT_CARD':
      return 'warning';
    case 'COMP':
      return 'outline';
    default:
      return 'outline';
  }
}

/** Badge color mapping for payment status. */
function statusVariant(status: string): 'default' | 'outline' | 'success' | 'warning' {
  switch (status.toUpperCase()) {
    case 'COMPLETED':
    case 'SETTLED':
      return 'success';
    case 'PENDING':
    case 'PROCESSING':
      return 'warning';
    case 'REFUNDED':
    case 'VOIDED':
      return 'outline';
    default:
      return 'default';
  }
}

/**
 * Accounting/transactions journal: one row per Payment, keyed by `processed_at`
 * (the cash-movement date). Shows the per-tender reconciliation breakdown and the
 * grand total — the form a bookkeeper imports into QuickBooks or Xero.
 */
export function TransactionsReportView({ report }: TransactionsReportViewProps) {
  const { transactions, byMethod } = report;
  const hasData = transactions.length > 0;

  const txnColumns: Array<Column<TransactionRow>> = [
    {
      id: 'date',
      header: 'Date',
      cell: (row) => (
        <span className="whitespace-nowrap text-slate-700">{formatDateTime(row.date)}</span>
      ),
    },
    {
      id: 'order',
      header: 'Order',
      cell: (row) => (
        <span className="font-medium text-slate-900">{row.orderNumber}</span>
      ),
    },
    {
      id: 'customer',
      header: 'Customer',
      cell: (row) => <span className="text-slate-700">{row.customerName}</span>,
    },
    {
      id: 'method',
      header: 'Method',
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant={methodVariant(row.method)}>{row.method}</Badge>
          {row.manuallyKeyed ? (
            <span className="rounded bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
              keyed
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'processor',
      header: 'Processor',
      cell: (row) => (
        <span className="text-xs text-slate-500">
          {row.processor}
          {row.processorTransactionId ? (
            <span
              className="ml-1 font-mono text-slate-400"
              title={row.processorTransactionId}
            >
              #{row.processorTransactionId.slice(-6)}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => <Badge variant={statusVariant(row.status)}>{row.status}</Badge>,
    },
    {
      id: 'gross',
      header: 'Gross',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums text-slate-700">{formatUSD(row.grossCents)}</span>
      ),
    },
    {
      id: 'refunded',
      header: 'Refunded',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums text-slate-500">
          {row.refundedCents > 0 ? `−${formatUSD(row.refundedCents)}` : '—'}
        </span>
      ),
    },
    {
      id: 'net',
      header: 'Net',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums font-medium text-slate-900">
          {formatUSD(row.netCents)}
        </span>
      ),
    },
  ];

  const methodColumns: Array<Column<MethodTotal>> = [
    {
      id: 'method',
      header: 'Tender',
      cell: (row) => (
        <Badge variant={methodVariant(row.method)}>{row.method}</Badge>
      ),
    },
    {
      id: 'count',
      header: 'Transactions',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums text-slate-700">{formatNumber(row.count)}</span>
      ),
    },
    {
      id: 'gross',
      header: 'Gross',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums text-slate-700">{formatUSD(row.grossCents)}</span>
      ),
    },
    {
      id: 'refunded',
      header: 'Refunded',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums text-slate-500">
          {row.refundedCents > 0 ? `−${formatUSD(row.refundedCents)}` : '—'}
        </span>
      ),
    },
    {
      id: 'net',
      header: 'Net',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums font-semibold text-slate-900">
          {formatUSD(row.netCents)}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Headline KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Net collected" value={formatUSD(report.totalNetCents)} icon={DollarSign} />
        <KpiCard label="Gross charged" value={formatUSD(report.totalGrossCents)} icon={CreditCard} />
        <KpiCard
          label="Total refunded"
          value={formatUSD(report.totalRefundedCents)}
          icon={RotateCcw}
        />
        <KpiCard label="Transactions" value={formatNumber(report.count)} icon={Hash} />
      </div>

      {/* Per-tender reconciliation */}
      <Card>
        <CardHeader>
          <CardTitle>Tender reconciliation</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={methodColumns}
            rows={byMethod}
            getRowKey={(row) => row.method}
            emptyState={
              <EmptyState
                icon={CreditCard}
                title="No transactions in this range"
                description="Payments processed in the selected date range will appear here."
              />
            }
          />

          {/* Grand-total footer */}
          {byMethod.length > 0 ? (
            <div className="mt-3 flex items-center justify-between border-t border-slate-200 pt-3 text-sm font-semibold text-slate-900">
              <span>Total — {formatNumber(report.count)} transactions</span>
              <span className="flex gap-8 tabular-nums">
                <span>{formatUSD(report.totalGrossCents)} gross</span>
                <span className="text-slate-500">
                  {report.totalRefundedCents > 0
                    ? `−${formatUSD(report.totalRefundedCents)} refunded`
                    : '—'}
                </span>
                <span>{formatUSD(report.totalNetCents)} net</span>
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Transaction journal */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle>Transaction journal</CardTitle>
          <span className="text-xs text-slate-400">
            {formatDate(report.from)} – {formatDate(report.to)}
          </span>
        </CardHeader>
        <CardContent>
          {hasData ? (
            <DataTable
              columns={txnColumns}
              rows={transactions}
              getRowKey={(row) => row.paymentId}
            />
          ) : (
            <EmptyState
              icon={CreditCard}
              title="No transactions in this range"
              description="Payments processed in the selected date range will appear here."
            />
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-slate-400">
        Keyed by <em>processed_at</em> (the cash-movement date). Refunds are netted into the
        originating payment row — there are no standalone refund transactions. Suitable for
        QuickBooks / Xero import.
      </p>
    </div>
  );
}
