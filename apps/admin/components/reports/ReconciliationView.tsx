import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  HandCoins,
  Landmark,
  ScrollText,
  Wallet,
} from 'lucide-react';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@marina/ui';
import { KpiCard } from '../shell';
import { DataTable, type Column } from '../shell/DataTable';
import { formatNumber, formatUSD } from '../../lib/format';

/**
 * Why one day's two ledgers disagree. Every variance the report can show has a
 * kind, because "off by $12" is only useful once it becomes "off by $12 because
 * a chargeback is being held on order LSM-1043".
 */
export type VarianceKind =
  | 'MISSING_IN_PROCESSOR'
  | 'MISSING_IN_LEDGER'
  | 'AMOUNT_MISMATCH'
  | 'REFUND_MISMATCH'
  | 'DISPUTE_HELD'
  | 'DISPUTE_RELEASED'
  | 'CHARGEBACK_WRITEOFF'
  | 'DISPUTE_UNRECORDED'
  | 'UNLINKED'
  | 'TIMING';

/** Display copy for each variance kind: a short label and what it means. */
export const VARIANCE_KIND_LABEL: Record<VarianceKind, string> = {
  MISSING_IN_PROCESSOR: 'Not at the processor',
  MISSING_IN_LEDGER: 'Missing from our books',
  AMOUNT_MISMATCH: 'Amount differs',
  REFUND_MISMATCH: 'Refund differs',
  DISPUTE_HELD: 'Funds held for a dispute',
  DISPUTE_RELEASED: 'Held funds returned',
  CHARGEBACK_WRITEOFF: 'Chargeback written off',
  DISPUTE_UNRECORDED: 'Chargeback not recorded',
  UNLINKED: 'No processor reference',
  TIMING: 'Settlement timing',
};

/** Which variances need somebody to act, versus which merely explain a gap. */
export const VARIANCE_SEVERITY: Record<VarianceKind, 'action' | 'explained'> = {
  MISSING_IN_PROCESSOR: 'action',
  MISSING_IN_LEDGER: 'action',
  AMOUNT_MISMATCH: 'action',
  REFUND_MISMATCH: 'action',
  DISPUTE_UNRECORDED: 'action',
  UNLINKED: 'action',
  DISPUTE_HELD: 'explained',
  DISPUTE_RELEASED: 'explained',
  CHARGEBACK_WRITEOFF: 'explained',
  TIMING: 'explained',
};

/** One itemized reason two ledgers differ. */
export interface ReconciliationVariance {
  id: string;
  /** Local ISO date (YYYY-MM-DD) the difference lands on. */
  date: string;
  kind: VarianceKind;
  orderId: string | null;
  orderNumber: string | null;
  paymentId: string | null;
  /** The processor's PaymentIntent reference, when there is one. */
  intentId: string | null;
  /** What our books say for this item, integer cents. Null when we have no record. */
  ledgerCents: number | null;
  /** What the processor says, integer cents. Null when the processor has no record. */
  processorCents: number | null;
  /** ledger − processor, signed. Positive = we think we have more than they do. */
  varianceCents: number;
  /** One sentence an operator can read without knowing the data model. */
  detail: string;
  /** What to do about it. */
  action: string;
}

/** One day of the two ledgers side by side. */
export interface ReconciliationDay {
  date: string;
  ledgerChargedCents: number;
  ledgerRefundedCents: number;
  ledgerChargebackCents: number;
  ledgerNetCents: number;
  processorCapturedCents: number;
  processorRefundedCents: number;
  /** Signed: negative when the processor withheld for a dispute, positive when it returned it. */
  processorDisputeCents: number;
  processorNetCents: number;
  varianceCents: number;
  balanced: boolean;
  /** Number of itemized variances that land on this day. */
  varianceCount: number;
}

/** Payments that never touch the card processor, so they can never reconcile against it. */
export interface NonCardTotal {
  method: string;
  label: string;
  netCents: number;
  count: number;
}

export interface ReconciliationReport {
  range: { from: string; to: string };
  /**
   * Where the processor side came from.
   *   `sandbox` — the local payment simulator's own ledger (no account needed).
   *   `none`    — no processor statement is available for this range.
   */
  source: 'sandbox' | 'none';
  /** Why there is no processor side, when `source` is `none`. */
  sourceNote: string | null;
  totals: {
    ledgerNetCents: number;
    processorNetCents: number;
    varianceCents: number;
    balanced: boolean;
    /** Card payments matched to a processor record. */
    matchedCount: number;
    /** Card payments with no processor record, or vice versa. */
    unmatchedCount: number;
    /** Disputed money the processor is holding right now. */
    heldCents: number;
    /** Chargebacks that resolved against the operator in this range. */
    chargebackCents: number;
  };
  days: ReconciliationDay[];
  variances: ReconciliationVariance[];
  nonCard: NonCardTotal[];
}

export interface ReconciliationViewProps {
  report: ReconciliationReport;
}

/** Signed money, with the sign kept — a variance reads wrong without it. */
function signedUSD(cents: number): string {
  if (cents === 0) return formatUSD(0);
  return cents > 0 ? `+${formatUSD(cents)}` : `−${formatUSD(Math.abs(cents))}`;
}

function varianceClass(cents: number): string {
  if (cents === 0) return 'tabular-nums text-ink-muted';
  return cents > 0 ? 'tabular-nums font-medium text-amber-700' : 'tabular-nums font-medium text-red-700';
}

/**
 * Reconciliation report: what we believe we collected against what the processor
 * says it holds, day by day, with every difference itemized.
 *
 * The design rule here is that nothing gets smoothed over. A day that does not
 * balance is called out in red and carries a list of the exact items that made
 * it not balance — an operator has to be able to answer "why is today off by
 * $12" from this screen alone, without opening a database or a Stripe dashboard.
 *
 * The two sides are deliberately built from different sources: ours from the
 * Payment/OrderEvent ledger, theirs from the processor's own record of each
 * charge. If they agreed by construction the report would prove nothing.
 */
export function ReconciliationView({ report }: ReconciliationViewProps) {
  const { totals, days, variances } = report;
  const actionable = variances.filter((v) => VARIANCE_SEVERITY[v.kind] === 'action');
  const explained = variances.filter((v) => VARIANCE_SEVERITY[v.kind] === 'explained');

  const dayColumns: Array<Column<ReconciliationDay>> = [
    {
      id: 'date',
      header: 'Day',
      cell: (d) => (
        <span className={d.balanced ? 'font-medium text-ink' : 'font-medium text-red-700'}>
          {d.date}
        </span>
      ),
    },
    {
      id: 'charged',
      header: 'Charged',
      align: 'right',
      cell: (d) => <span className="tabular-nums text-ink-body">{formatUSD(d.ledgerChargedCents)}</span>,
    },
    {
      id: 'refunded',
      header: 'Refunded',
      align: 'right',
      cell: (d) => (
        <span className={d.ledgerRefundedCents ? 'tabular-nums text-ink-body' : 'tabular-nums text-ink-muted'}>
          {d.ledgerRefundedCents ? `−${formatUSD(d.ledgerRefundedCents)}` : formatUSD(0)}
        </span>
      ),
    },
    {
      id: 'chargebacks',
      header: 'Chargebacks',
      align: 'right',
      cell: (d) => (
        <span className={d.ledgerChargebackCents ? 'tabular-nums text-red-700' : 'tabular-nums text-ink-muted'}>
          {d.ledgerChargebackCents ? `−${formatUSD(d.ledgerChargebackCents)}` : formatUSD(0)}
        </span>
      ),
    },
    {
      id: 'ours',
      header: 'Our net',
      align: 'right',
      cell: (d) => <span className="tabular-nums font-medium text-ink">{formatUSD(d.ledgerNetCents)}</span>,
    },
    {
      id: 'theirs',
      header: 'Processor net',
      align: 'right',
      cell: (d) => <span className="tabular-nums font-medium text-ink">{formatUSD(d.processorNetCents)}</span>,
    },
    {
      id: 'variance',
      header: 'Variance',
      align: 'right',
      cell: (d) => (
        <span className={varianceClass(d.varianceCents)}>
          {d.varianceCents === 0 ? '—' : signedUSD(d.varianceCents)}
        </span>
      ),
    },
    {
      id: 'status',
      header: '',
      align: 'right',
      cell: (d) =>
        d.balanced ? (
          <Badge variant="success">
            <CheckCircle2 className="h-3 w-3" aria-hidden />
            Balanced
          </Badge>
        ) : (
          <Badge variant="danger">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {formatNumber(d.varianceCount)} reason{d.varianceCount === 1 ? '' : 's'}
          </Badge>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="We collected (net)" value={formatUSD(totals.ledgerNetCents)} icon={Wallet} />
        <KpiCard
          label="Processor says (net)"
          value={report.source === 'none' ? '—' : formatUSD(totals.processorNetCents)}
          icon={Landmark}
        />
        <KpiCard label="Variance" value={signedUSD(totals.varianceCents)} icon={ScrollText} />
        <KpiCard label="Held in dispute" value={formatUSD(totals.heldCents)} icon={HandCoins} />
      </div>

      <VerdictBanner report={report} actionableCount={actionable.length} />

      <Card>
        <CardHeader>
          <CardTitle>Day by day</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={dayColumns}
            rows={days}
            getRowKey={(d) => d.date}
            emptyState={
              <EmptyState
                icon={ScrollText}
                title="Nothing to reconcile"
                description="No card payments were taken in this range."
              />
            }
          />
        </CardContent>
      </Card>

      <VarianceCard
        title="Differences to resolve"
        description="Each of these is a real gap between our books and the processor. Nothing here is rounding."
        rows={actionable}
        emptyTitle="Nothing unexplained"
        emptyDescription="Every card payment in this range matches the processor's record of it."
        tone="action"
      />

      <VarianceCard
        title="Explained differences"
        description="Money the processor is holding or has moved for a reason we already know about. These resolve themselves; they are listed so the day totals add up."
        rows={explained}
        emptyTitle="No held or in-flight funds"
        emptyDescription="No disputes or timing differences affected this range."
        tone="explained"
      />

      {report.nonCard.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Not settled by card</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-ink-muted">
              These payments never reach the card processor, so they are excluded from the
              comparison above. Add them back to compare this report against the revenue report.
            </p>
            <dl className="divide-y divide-line text-sm">
              {report.nonCard.map((row) => (
                <div key={row.method} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                  <dt className="text-ink-muted">
                    {row.label}
                    <span className="ml-2 text-xs text-ink-muted">
                      {formatNumber(row.count)} payment{row.count === 1 ? '' : 's'}
                    </span>
                  </dt>
                  <dd className="tabular-nums font-medium text-ink">{formatUSD(row.netCents)}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/** The one-line answer: does the range balance, and if not, by how much and why. */
function VerdictBanner({
  report,
  actionableCount,
}: {
  report: ReconciliationReport;
  actionableCount: number;
}) {
  if (report.source === 'none') {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-line bg-surface-muted p-4">
        <CircleSlash className="mt-0.5 h-5 w-5 shrink-0 text-ink-muted" aria-hidden />
        <div className="text-sm">
          <p className="font-medium text-ink">No processor statement for this range</p>
          <p className="mt-0.5 text-ink-body">
            {report.sourceNote ??
              'Nothing to compare against yet. Our own figures are shown below unreconciled.'}
          </p>
        </div>
      </div>
    );
  }

  const { totals } = report;
  if (totals.balanced) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
        <div className="text-sm">
          <p className="font-medium text-emerald-900">
            This range reconciles to the cent across {formatNumber(totals.matchedCount)} card payment
            {totals.matchedCount === 1 ? '' : 's'}.
          </p>
          <p className="mt-0.5 text-emerald-800">
            Our net of {formatUSD(totals.ledgerNetCents)} matches the processor exactly.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden />
      <div className="text-sm">
        <p className="font-medium text-red-900">
          Off by {formatUSD(Math.abs(totals.varianceCents))}
          {totals.varianceCents > 0
            ? ' — we are counting money the processor is not holding.'
            : ' — the processor is holding money we have not counted.'}
        </p>
        <p className="mt-0.5 text-red-800">
          {actionableCount > 0
            ? `${formatNumber(actionableCount)} item${actionableCount === 1 ? '' : 's'} need a decision; the rest is explained below.`
            : 'Every difference is explained below — no action needed, but the totals will not match until the disputes resolve.'}
        </p>
      </div>
    </div>
  );
}

function VarianceCard({
  title,
  description,
  rows,
  emptyTitle,
  emptyDescription,
  tone,
}: {
  title: string;
  description: string;
  rows: ReconciliationVariance[];
  emptyTitle: string;
  emptyDescription: string;
  tone: 'action' | 'explained';
}) {
  const columns: Array<Column<ReconciliationVariance>> = [
    { id: 'date', header: 'Day', cell: (v) => <span className="tabular-nums text-ink-body">{v.date}</span> },
    {
      id: 'kind',
      header: 'Reason',
      cell: (v) => (
        <Badge variant={tone === 'action' ? 'danger' : 'warning'}>{VARIANCE_KIND_LABEL[v.kind]}</Badge>
      ),
    },
    {
      id: 'order',
      header: 'Order',
      cell: (v) =>
        v.orderNumber ? (
          <span className="font-medium text-ink">{v.orderNumber}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      id: 'detail',
      header: 'What happened',
      cell: (v) => (
        <div className="max-w-md">
          <p className="text-ink-body">{v.detail}</p>
          <p className="mt-0.5 text-xs text-ink-muted">{v.action}</p>
          {v.intentId ? (
            <p className="mt-0.5 font-mono text-[11px] text-ink-muted">{v.intentId}</p>
          ) : null}
        </div>
      ),
    },
    {
      id: 'ours',
      header: 'Ours',
      align: 'right',
      cell: (v) => (
        <span className="tabular-nums text-ink-body">
          {v.ledgerCents === null ? '—' : formatUSD(v.ledgerCents)}
        </span>
      ),
    },
    {
      id: 'theirs',
      header: 'Processor',
      align: 'right',
      cell: (v) => (
        <span className="tabular-nums text-ink-body">
          {v.processorCents === null ? '—' : formatUSD(v.processorCents)}
        </span>
      ),
    },
    {
      id: 'variance',
      header: 'Variance',
      align: 'right',
      cell: (v) => <span className={varianceClass(v.varianceCents)}>{signedUSD(v.varianceCents)}</span>,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-ink-muted">{description}</p>
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(v) => v.id}
          emptyState={
            <EmptyState
              icon={tone === 'action' ? CheckCircle2 : ScrollText}
              title={emptyTitle}
              description={emptyDescription}
            />
          }
        />
      </CardContent>
    </Card>
  );
}
