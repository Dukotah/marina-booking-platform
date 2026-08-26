/**
 * Accounting export service — pulls a period's money out of the database and
 * hands it to the pure export math in `@marina/core/accounting`.
 *
 * The split is deliberate: everything that can be reasoned about (the GL
 * mapping, the proration, the reconciliation identity) is pure and unit-tested;
 * this file only fetches rows and records the run. Nothing here does money
 * arithmetic beyond summing an aggregate the database already computed.
 *
 * Basis: revenue is recognized on the ORDER date (accrual). An order that was
 * booked with a deposit shows its full revenue in the booking period and carries
 * the unpaid part as a receivable, which is why the reconciliation reports A/R
 * separately instead of quietly reducing revenue. The payments that actually
 * SETTLED inside the window are fetched separately as the bank-statement side of
 * the tie-out, so a deposit taken Friday and a balance collected Saturday are
 * both visible rather than silently mismatching.
 *
 * All data access is tenant-scoped (`forOperator` → RLS).
 */

import { forOperator, type AccountingExport, type AccountingExportKind } from '@marina/database';
import {
  buildAccountingExport,
  serializeExport,
  exportContentType,
  exportFilename,
  formatDateInZone,
  EXPORT_FORMATS,
  type AccountingExportResult,
  type ChartOverrides,
  type ExportFormat,
  type ExportOrderRow,
  type GiftForfeitRow,
  type GiftIssueRow,
  type SettlementRow,
  type TaxGranularity,
} from '@marina/core';

/** A typed, user-facing failure route handlers map to a clean HTTP status. */
export class AccountingExportError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'AccountingExportError';
    this.code = code;
    this.status = status;
  }
}

/** Refuse to scan an unbounded range — an export is a period, not a table dump. */
const MAX_PERIOD_DAYS = 400;

export interface PeriodInput {
  /** Inclusive start / exclusive end, UTC instants. */
  start: Date;
  end: Date;
  taxGranularity?: TaxGranularity;
  /** Per-run GL account overrides, keyed by role or `REVENUE:<CATEGORY>`. */
  overrides?: ChartOverrides;
}

export function assertValidPeriod(start: Date, end: Date): void {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new AccountingExportError('INVALID_PERIOD', 'start and end must be valid dates.');
  }
  if (end <= start) {
    throw new AccountingExportError('INVALID_PERIOD', 'end must be after start.');
  }
  const days = (end.getTime() - start.getTime()) / 86_400_000;
  if (days > MAX_PERIOD_DAYS) {
    throw new AccountingExportError(
      'PERIOD_TOO_LONG',
      `Export periods are limited to ${MAX_PERIOD_DAYS} days; requested ${Math.ceil(days)}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Period resolution
//
// A bookkeeper asks for "June", meaning June in the marina's timezone. Taking
// plain dates as UTC would push every late-afternoon Pacific booking on the last
// day of the month into the next month's tax return, so calendar dates are
// resolved against the operator's timezone here rather than at the edge.
// ---------------------------------------------------------------------------

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** How far the zone is ahead of UTC at `at`, in ms (positive west of Greenwich). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  let fmt = offsetFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(at);
  const num = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asIfUtc = Date.UTC(
    num('year'),
    num('month') - 1,
    num('day'),
    num('hour'),
    num('minute'),
    num('second'),
  );
  return at.getTime() - asIfUtc;
}

/**
 * The UTC instant of local midnight on `YYYY-MM-DD` in `timeZone`. Applied
 * twice because a date whose midnight sits on a DST transition has a different
 * offset before and after the correction; the second pass settles it.
 */
export function zonedMidnightUtc(dateISO: string, timeZone: string): Date {
  const guess = new Date(`${dateISO}T00:00:00.000Z`);
  if (Number.isNaN(guess.getTime())) {
    throw new AccountingExportError('INVALID_PERIOD', `"${dateISO}" is not a YYYY-MM-DD date.`);
  }
  let result = new Date(guess.getTime() + zoneOffsetMs(guess, timeZone));
  const settled = new Date(guess.getTime() + zoneOffsetMs(result, timeZone));
  if (settled.getTime() !== result.getTime()) result = settled;
  return result;
}

export interface PeriodQuery {
  /** Calendar day (YYYY-MM-DD) in the operator's timezone, inclusive. */
  start?: string;
  /** Calendar day (YYYY-MM-DD) in the operator's timezone, INCLUSIVE. */
  end?: string;
  /** Exact UTC instant, inclusive. Wins over `start` when both are given. */
  startAt?: string;
  /** Exact UTC instant, EXCLUSIVE. Wins over `end` when both are given. */
  endAt?: string;
}

export interface ResolvedPeriod {
  start: Date;
  end: Date;
  timeZone: string;
}

/**
 * Turn a caller's period query into the half-open UTC window the export runs on.
 * Calendar dates are operator-local and the end date is inclusive, because
 * "June 1 to June 30" is what a human means; the exclusive boundary is derived
 * by advancing one local day.
 */
export async function resolvePeriod(
  operatorId: string,
  query: PeriodQuery,
): Promise<ResolvedPeriod> {
  const db = forOperator(operatorId);
  const operator = await db.operator.findFirst({ select: { timezone: true } });
  if (!operator) {
    throw new AccountingExportError('OPERATOR_NOT_FOUND', 'Operator not found.', 404);
  }
  const timeZone = operator.timezone;

  const start = query.startAt
    ? new Date(query.startAt)
    : query.start
      ? zonedMidnightUtc(query.start, timeZone)
      : null;
  if (!start) {
    throw new AccountingExportError('INVALID_PERIOD', 'A start date is required.');
  }

  let end: Date;
  if (query.endAt) {
    end = new Date(query.endAt);
  } else if (query.end) {
    // Inclusive calendar end → exclusive instant: midnight of the NEXT local day.
    const nextDay = new Date(`${query.end}T00:00:00.000Z`);
    if (Number.isNaN(nextDay.getTime())) {
      throw new AccountingExportError('INVALID_PERIOD', `"${query.end}" is not a YYYY-MM-DD date.`);
    }
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    end = zonedMidnightUtc(nextDay.toISOString().slice(0, 10), timeZone);
  } else {
    throw new AccountingExportError('INVALID_PERIOD', 'An end date is required.');
  }

  assertValidPeriod(start, end);
  return { start, end, timeZone };
}

function customerName(c: { first_name: string; last_name: string } | null): string {
  if (!c) return 'Unknown';
  return `${c.first_name} ${c.last_name}`.trim() || 'Unknown';
}

/**
 * Fetch every row the export needs and run the math. Read-only apart from
 * nothing — `recordAccountingExport` is a separate call so a preview in the
 * admin UI does not litter the receipt table.
 */
export async function buildExportForPeriod(
  operatorId: string,
  period: PeriodInput,
): Promise<AccountingExportResult & { giftLiabilityNowCents: number }> {
  assertValidPeriod(period.start, period.end);
  const db = forOperator(operatorId);

  const [operator, glAccounts, orders, giftCards, giftCertificates, settlementPayments] =
    await Promise.all([
      db.operator.findFirst({ select: { name_internal: true, timezone: true } }),
      db.gLAccount.findMany({
        select: { code: true, name: true, category: true, is_active: true },
        orderBy: { code: 'asc' },
      }),
      db.order.findMany({
        where: { created_at: { gte: period.start, lt: period.end } },
        select: {
          id: true,
          order_number: true,
          created_at: true,
          status: true,
          subtotal_cents: true,
          discount_cents: true,
          tax_cents: true,
          processing_fee_cents: true,
          tip_cents: true,
          total_cents: true,
          amount_paid_cents: true,
          balance_due_cents: true,
          customer: { select: { first_name: true, last_name: true } },
          items: {
            select: {
              quantity: true,
              unit_price_cents: true,
              activity: { select: { id: true, name_internal: true, category: true } },
            },
          },
          payments: {
            select: {
              id: true,
              method: true,
              status: true,
              amount_cents: true,
              refunded_cents: true,
              processed_at: true,
            },
          },
        },
        orderBy: { created_at: 'asc' },
      }),
      db.giftCard.findMany({
        where: { created_at: { gte: period.start, lt: period.end } },
        select: { id: true, code: true, initial_cents: true, created_at: true },
      }),
      db.giftCertificate.findMany({
        where: { created_at: { gte: period.start, lt: period.end } },
        select: { id: true, code: true, value_cents: true, created_at: true },
      }),
      // The bank side: everything that settled in the window, whatever period
      // its order belongs to.
      db.payment.findMany({
        where: { processed_at: { gte: period.start, lt: period.end } },
        select: {
          id: true,
          method: true,
          status: true,
          amount_cents: true,
          refunded_cents: true,
          processed_at: true,
        },
      }),
    ]);

  if (!operator) {
    throw new AccountingExportError('OPERATOR_NOT_FOUND', 'Operator not found.', 404);
  }

  // Gift cards/certificates that left the ACTIVE pool inside the window. The
  // status change is only dated by updated_at, so a card edited for another
  // reason after expiring would land in the wrong period — acceptable because
  // breakage is small and the alternative (a status-history table) does not
  // exist yet. Flagged in the export config so the run is self-describing.
  const [forfeitedCards, forfeitedCertificates] = await Promise.all([
    db.giftCard.findMany({
      where: { status: { in: ['EXPIRED', 'VOID'] }, updated_at: { gte: period.start, lt: period.end } },
      select: { id: true, code: true, balance_cents: true, updated_at: true },
    }),
    db.giftCertificate.findMany({
      where: { status: { in: ['EXPIRED', 'VOID'] }, updated_at: { gte: period.start, lt: period.end } },
      select: { id: true, code: true, value_cents: true, updated_at: true },
    }),
  ]);

  const [cardLiability, certificateLiability] = await Promise.all([
    db.giftCard.aggregate({ where: { status: 'ACTIVE' }, _sum: { balance_cents: true } }),
    db.giftCertificate.aggregate({ where: { status: 'ACTIVE' }, _sum: { value_cents: true } }),
  ]);

  const exportOrders: ExportOrderRow[] = orders.map((o) => ({
    orderId: o.id,
    orderNumber: o.order_number,
    createdAt: o.created_at,
    status: o.status,
    customerName: customerName(o.customer),
    subtotalCents: o.subtotal_cents,
    discountCents: o.discount_cents,
    taxCents: o.tax_cents,
    processingFeeCents: o.processing_fee_cents,
    tipCents: o.tip_cents,
    totalCents: o.total_cents,
    amountPaidCents: o.amount_paid_cents,
    balanceDueCents: o.balance_due_cents,
    items: o.items.map((i) => ({
      activityId: i.activity.id,
      activityName: i.activity.name_internal,
      category: i.activity.category,
      quantity: i.quantity,
      unitPriceCents: i.unit_price_cents,
    })),
    payments: o.payments.map((p) => ({
      paymentId: p.id,
      method: p.method,
      status: p.status,
      amountCents: p.amount_cents,
      refundedCents: p.refunded_cents,
      processedAt: p.processed_at,
    })),
  }));

  // A gift card sold is a liability at FACE value; `initial_cents` is that face
  // value and never moves, unlike `balance_cents`, which the first redemption
  // would already have reduced.
  const giftIssues: GiftIssueRow[] = [
    ...giftCards.map((g) => ({
      id: g.id,
      code: g.code,
      kind: 'GIFT_CARD' as const,
      issuedAt: g.created_at,
      faceValueCents: g.initial_cents,
    })),
    ...giftCertificates.map((g) => ({
      id: g.id,
      code: g.code,
      kind: 'GIFT_CERTIFICATE' as const,
      issuedAt: g.created_at,
      faceValueCents: g.value_cents,
    })),
  ];

  const giftForfeits: GiftForfeitRow[] = [
    ...forfeitedCards.map((g) => ({
      id: g.id,
      code: g.code,
      kind: 'GIFT_CARD' as const,
      forfeitedAt: g.updated_at,
      amountCents: g.balance_cents,
    })),
    ...forfeitedCertificates.map((g) => ({
      id: g.id,
      code: g.code,
      kind: 'GIFT_CERTIFICATE' as const,
      forfeitedAt: g.updated_at,
      amountCents: g.value_cents,
    })),
  ];

  const settlements: SettlementRow[] = settlementPayments.map((p) => ({
    paymentId: p.id,
    method: p.method,
    status: p.status,
    amountCents: p.amount_cents,
    refundedCents: p.refunded_cents,
    processedAt: p.processed_at,
  }));

  const result = buildAccountingExport({
    periodStart: period.start,
    periodEnd: period.end,
    timeZone: operator.timezone,
    operatorName: operator.name_internal,
    orders: exportOrders,
    giftIssues,
    giftForfeits,
    settlements,
    accounts: glAccounts,
    overrides: period.overrides,
    taxGranularity: period.taxGranularity,
  });

  return {
    ...result,
    // As-of-now, not as-of-period-end: neither GiftCard.balance_cents nor
    // GiftCertificate.status carries history, so a point-in-time liability
    // cannot be reconstructed. Reported under a name that says so.
    giftLiabilityNowCents:
      (cardLiability._sum.balance_cents ?? 0) + (certificateLiability._sum.value_cents ?? 0),
  };
}

/** The file formats a caller may request, re-exported so routes validate against one list. */
export { EXPORT_FORMATS, type ExportFormat };

export interface SerializedExport {
  body: string;
  contentType: string;
  filename: string;
  /** Whether the period reconciled — routes surface it as a response header. */
  balanced: boolean;
  varianceCents: number;
  rowCount: number;
  totalCents: number;
}

/** Render a finished export into a downloadable file plus its metadata. */
export function serializeForDownload(
  result: AccountingExportResult,
  format: ExportFormat,
): SerializedExport {
  const start = formatDateInZone(result.periodStart, result.timeZone, 'ISO');
  const end = formatDateInZone(new Date(result.periodEnd.getTime() - 1), result.timeZone, 'ISO');
  return {
    body: serializeExport(result, format),
    contentType: exportContentType(format),
    filename: exportFilename(format, start, end),
    balanced: result.reconciliation.balanced,
    varianceCents: result.reconciliation.varianceCents,
    rowCount: result.journal.lines.length,
    totalCents: result.journal.debitsCents,
  };
}

/** Map a requested file format onto the AccountingExportKind the receipt records. */
function kindForFormat(format: ExportFormat): AccountingExportKind {
  if (format === 'quickbooks-csv' || format === 'quickbooks-iif') return 'QUICKBOOKS';
  if (format === 'xero-csv') return 'XERO';
  return 'CSV';
}

/**
 * Record that an export was generated. The row is the receipt: re-running the
 * same window later and getting a different total is exactly the drift a
 * bookkeeper needs to see, and that comparison is only possible if the first run
 * was written down. Top-level create, so `operator_id` is explicit (D-011).
 */
export async function recordAccountingExport(
  operatorId: string,
  input: {
    format: ExportFormat;
    period: PeriodInput;
    result: AccountingExportResult;
    generatedBy?: string | null;
  },
): Promise<AccountingExport> {
  const db = forOperator(operatorId);
  const { result } = input;
  return db.accountingExport.create({
    data: {
      operator_id: operatorId,
      kind: kindForFormat(input.format),
      period_start: input.period.start,
      period_end: input.period.end,
      generated_by: input.generatedBy ?? null,
      row_count: result.journal.lines.length,
      // Debits equal credits in a balanced entry, so either side is "the total";
      // debits is the conventional one to quote.
      total_cents: result.journal.debitsCents,
      config: {
        format: input.format,
        timeZone: result.timeZone,
        journalNo: result.journal.journalNo,
        taxGranularity: result.tax.granularity,
        overrides: input.period.overrides ?? {},
        balanced: result.reconciliation.balanced,
        varianceCents: result.reconciliation.varianceCents,
        orderCount: result.reconciliation.orderCount,
        collectedCents: result.reconciliation.collectedCents,
        taxDueCents: result.tax.totals.taxDueCents,
        issueCount: result.issues.length,
        // Breakage is dated by updated_at; say so on the run itself so a future
        // reader does not have to rediscover it.
        breakageDatedBy: 'gift_card.updated_at',
      },
    },
  });
}

/** Past export runs, newest first — the audit trail for "we already filed this". */
export async function listAccountingExports(
  operatorId: string,
  limit = 50,
): Promise<AccountingExport[]> {
  const db = forOperator(operatorId);
  return db.accountingExport.findMany({
    orderBy: { generated_at: 'desc' },
    take: Math.min(Math.max(1, limit), 200),
  });
}
