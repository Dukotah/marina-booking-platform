// @marina/core — accounting export math (pure, DB-free).
//
// Turns a period's orders, payments and gift-card movements into a balanced
// double-entry journal, a reconciliation that proves the period, a sales-tax
// remittance summary, and the exact file shapes QuickBooks and Xero import.
//
// Why a journal and not a flat CSV of totals: a flat total can be wrong and
// still look plausible. A journal cannot — debits must equal credits, so a
// mapping mistake surfaces as a file the bookkeeper's software rejects instead
// of a silently understated tax liability. Every figure below is derived, then
// checked against the figure the app stored; disagreements are reported as
// issues rather than smoothed over.
//
// All money is integer cents. There is no floating-point arithmetic here: the
// only division is inside `allocateProRata`, which uses integer quotients and
// remainders so the parts always sum exactly to the whole.

import { ACTIVITY_CATEGORIES } from './schemas.js';
import { PAYMENT_METHOD_KEYS, type PaymentMethodKey } from './reports.js';

/** Thrown when input money is not integer cents — a loud failure beats a wrong ledger. */
export class AccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountingError';
  }
}

export type ActivityCategoryKey = (typeof ACTIVITY_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Integer-cents primitives
// ---------------------------------------------------------------------------

/** Guard every money input at the boundary; DB Int columns are always integers. */
function assertCents(value: number, label: string): number {
  if (!Number.isInteger(value)) {
    throw new AccountingError(`${label} must be an integer number of cents (got ${value})`);
  }
  return value;
}

/**
 * Split `amountCents` across `weights` so the parts sum EXACTLY to the input —
 * the largest-remainder (Hamilton) method. This is the one and only rounding
 * rule in the accounting layer, and it is stated here so nobody has to guess:
 *
 *   1. Each bucket gets `floor(amount * weight / totalWeight)`.
 *   2. The cents left over (at most `buckets - 1` of them) go one each to the
 *      buckets with the largest integer remainder; ties break toward the lower
 *      index, so the result is deterministic for identical inputs.
 *   3. Negative amounts are allocated on the absolute value and negated, so a
 *      refund splits the same way the charge did.
 *   4. Negative or non-finite weights count as zero. If every weight is zero the
 *      amount is spread as evenly as possible — a zero-priced (comped) order
 *      still has to put its fee somewhere, and dropping it would lose money.
 *
 * No float ever touches the result: `amount * weight` and the remainder are
 * exact integers for any realistic cents value.
 */
export function allocateProRata(amountCents: number, weights: readonly number[]): number[] {
  assertCents(amountCents, 'allocateProRata amount');
  if (weights.length === 0) return [];

  const sign = amountCents < 0 ? -1 : 1;
  const abs = Math.abs(amountCents);

  const cleaned = weights.map((w) => (Number.isFinite(w) && w > 0 ? Math.round(w) : 0));
  const totalWeight = cleaned.reduce((a, b) => a + b, 0);
  const effective = totalWeight === 0 ? cleaned.map(() => 1) : cleaned;
  const effectiveTotal = totalWeight === 0 ? effective.length : totalWeight;

  const parts = effective.map((w) => Math.floor((abs * w) / effectiveTotal));
  const remainders = effective.map((w, i) => abs * w - parts[i] * effectiveTotal);

  let leftover = abs - parts.reduce((a, b) => a + b, 0);
  const order = remainders
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r - a.r) || (a.i - b.i));
  for (let k = 0; leftover > 0 && k < order.length; k++) {
    parts[order[k].i] += 1;
    leftover -= 1;
  }

  return parts.map((p) => p * sign);
}

/**
 * Render integer cents as the decimal string QuickBooks and Xero expect
 * ("1234.05", "-9.99"). Done with integer division and string padding rather
 * than `cents / 100` so no binary-float representation error can reach a file
 * somebody files taxes from.
 */
export function centsToDecimal(cents: number): string {
  const whole = Math.trunc(cents);
  const sign = whole < 0 ? '-' : '';
  const abs = Math.abs(whole);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Timezone-aware date keys
//
// Rows are stored UTC; a bookkeeper's "day" is the operator's local day. All
// grouping and every rendered date goes through here so an 11pm Pacific order
// never lands on tomorrow's tax return.
// ---------------------------------------------------------------------------

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(date: Date, timeZone: string): { year: string; month: string; day: string } {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      // An operator row with a bad timezone must not break the export; UTC is
      // the documented fallback and the dates stay internally consistent.
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    }
    partsFormatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** `YYYY-MM-DD` in the operator's timezone. */
export function zonedDayKey(date: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${year}-${month}-${day}`;
}

/** `YYYY-MM` in the operator's timezone. */
export function zonedMonthKey(date: Date, timeZone: string): string {
  const { year, month } = zonedParts(date, timeZone);
  return `${year}-${month}`;
}

/** Date formats the two targets accept: ISO for Xero, US for QuickBooks/IIF. */
export type DateStyle = 'ISO' | 'US';

export function formatDateInZone(date: Date, timeZone: string, style: DateStyle): string {
  const { year, month, day } = zonedParts(date, timeZone);
  return style === 'US' ? `${month}/${day}/${year}` : `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

/**
 * The accounting roles this export can post to. Tips and gift-card balances are
 * LIABILITIES, not revenue — money held on somebody else's behalf. Getting that
 * wrong overstates income and the tax on it, which is why they are distinct
 * roles rather than revenue sub-accounts.
 */
export type LedgerRole =
  | 'REVENUE'
  | 'DISCOUNTS'
  | 'OTHER_CHARGES'
  | 'SALES_TAX_PAYABLE'
  | 'PROCESSING_FEE_INCOME'
  | 'TIPS_PAYABLE'
  | 'REFUNDS'
  | 'GIFT_LIABILITY'
  | 'GIFT_BREAKAGE'
  | 'UNDEPOSITED_FUNDS'
  | 'CASH_ON_HAND'
  | 'COMPS'
  | 'ACCOUNTS_RECEIVABLE'
  | 'SUSPENSE';

export interface LedgerAccountRef {
  code: string;
  name: string;
  role: LedgerRole;
  /** Set for REVENUE lines: the activity category this sub-account carries. */
  category?: string;
}

/** Default revenue sub-account per activity category (a 4000-series chart). */
export const DEFAULT_REVENUE_ACCOUNTS: Record<ActivityCategoryKey, { code: string; name: string }> = {
  BOAT: { code: '4010', name: 'Boat Rental Revenue' },
  WATERCRAFT: { code: '4020', name: 'Watercraft Rental Revenue' },
  PATIO: { code: '4030', name: 'Patio & Facility Revenue' },
  LODGING: { code: '4040', name: 'Lodging Revenue' },
  TOUR: { code: '4050', name: 'Tour Revenue' },
  CLASS: { code: '4060', name: 'Class & Instruction Revenue' },
  EVENT: { code: '4070', name: 'Event Revenue' },
  EQUIPMENT: { code: '4080', name: 'Equipment Rental Revenue' },
  OTHER: { code: '4090', name: 'Other Revenue' },
};

/** Default account per non-revenue role. */
export const DEFAULT_ROLE_ACCOUNTS: Record<Exclude<LedgerRole, 'REVENUE'>, { code: string; name: string }> = {
  DISCOUNTS: { code: '4900', name: 'Discounts Given' },
  OTHER_CHARGES: { code: '4200', name: 'Other Charges & Surcharges' },
  SALES_TAX_PAYABLE: { code: '2200', name: 'Sales Tax Payable' },
  PROCESSING_FEE_INCOME: { code: '4100', name: 'Processing Fee Income' },
  TIPS_PAYABLE: { code: '2300', name: 'Tips Payable' },
  REFUNDS: { code: '4950', name: 'Refunds & Returns' },
  GIFT_LIABILITY: { code: '2400', name: 'Gift Card Liability' },
  GIFT_BREAKAGE: { code: '4300', name: 'Gift Card Breakage Income' },
  UNDEPOSITED_FUNDS: { code: '1200', name: 'Undeposited Funds' },
  CASH_ON_HAND: { code: '1000', name: 'Cash on Hand' },
  COMPS: { code: '4960', name: 'Comped Sales' },
  ACCOUNTS_RECEIVABLE: { code: '1100', name: 'Accounts Receivable' },
  SUSPENSE: { code: '9999', name: 'Suspense — Unreconciled' },
};

/**
 * Coarse `GLAccount.category` values an operator may already be using (the
 * schema's own example is "REVENUE" / "TAX" / "FEE"). Matching these keeps an
 * existing chart working without asking the operator to re-tag anything.
 */
const CATEGORY_ALIASES: Record<LedgerRole, readonly string[]> = {
  REVENUE: ['REVENUE', 'INCOME', 'SALES'],
  DISCOUNTS: ['DISCOUNTS', 'DISCOUNT'],
  OTHER_CHARGES: ['OTHER_CHARGES', 'SURCHARGE'],
  SALES_TAX_PAYABLE: ['SALES_TAX_PAYABLE', 'TAX', 'SALES_TAX'],
  PROCESSING_FEE_INCOME: ['PROCESSING_FEE_INCOME', 'FEE', 'FEES'],
  TIPS_PAYABLE: ['TIPS_PAYABLE', 'TIP', 'TIPS', 'GRATUITY'],
  REFUNDS: ['REFUNDS', 'REFUND'],
  GIFT_LIABILITY: ['GIFT_LIABILITY', 'GIFT_CARD', 'GIFT'],
  GIFT_BREAKAGE: ['GIFT_BREAKAGE', 'BREAKAGE'],
  UNDEPOSITED_FUNDS: ['UNDEPOSITED_FUNDS', 'CARD', 'CLEARING'],
  CASH_ON_HAND: ['CASH_ON_HAND', 'CASH'],
  COMPS: ['COMPS', 'COMP'],
  ACCOUNTS_RECEIVABLE: ['ACCOUNTS_RECEIVABLE', 'AR', 'RECEIVABLE'],
  SUSPENSE: ['SUSPENSE'],
};

/** A GLAccount row as the export needs it (code/name/category only). */
export interface GLAccountInput {
  code: string;
  name: string;
  category?: string | null;
  is_active?: boolean;
}

/**
 * Per-run account overrides, keyed by role or `REVENUE:<CATEGORY>`, valued by
 * account code. This is what `AccountingExport.config` carries — the mapping
 * itself lives on GLAccount, not duplicated per run.
 */
export type ChartOverrides = Record<string, string>;

export interface Chart {
  /** Resolve the account for a role (plus activity category for REVENUE). */
  account(role: LedgerRole, category?: string): LedgerAccountRef;
  /** Every account this chart can emit, for a "check your mapping" screen. */
  list(): LedgerAccountRef[];
}

function normalizeCategoryTag(raw: string | null | undefined): string {
  return (raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

/**
 * Build the chart used for one export run. Resolution order per key:
 *
 *   1. an explicit override code from the run config,
 *   2. an active GLAccount whose `category` matches the role (or one of its
 *      aliases); ties break on the lowest code so two runs never disagree,
 *   3. the built-in default account.
 *
 * Unknown activity categories fall back to the OTHER revenue account rather
 * than being dropped — revenue that vanishes is worse than revenue in the wrong
 * bucket, because only one of the two is visible on the P&L.
 */
export function resolveChart(opts?: {
  accounts?: readonly GLAccountInput[];
  overrides?: ChartOverrides;
}): Chart {
  const accounts = (opts?.accounts ?? []).filter((a) => a.is_active !== false);
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const overrides = opts?.overrides ?? {};

  const byTag = new Map<string, GLAccountInput[]>();
  for (const a of accounts) {
    const tag = normalizeCategoryTag(a.category);
    if (!tag) continue;
    const bucket = byTag.get(tag);
    if (bucket) bucket.push(a);
    else byTag.set(tag, [a]);
  }
  for (const bucket of byTag.values()) bucket.sort((a, b) => a.code.localeCompare(b.code));

  const cache = new Map<string, LedgerAccountRef>();

  function defaultFor(role: LedgerRole, category?: string): { code: string; name: string } {
    if (role !== 'REVENUE') return DEFAULT_ROLE_ACCOUNTS[role];
    const key = normalizeCategoryTag(category) as ActivityCategoryKey;
    return DEFAULT_REVENUE_ACCOUNTS[key] ?? DEFAULT_REVENUE_ACCOUNTS.OTHER;
  }

  function resolve(role: LedgerRole, category?: string): LedgerAccountRef {
    const cat = role === 'REVENUE' ? (normalizeCategoryTag(category) || 'OTHER') : undefined;
    const key = cat ? `REVENUE:${cat}` : role;
    const cached = cache.get(key);
    if (cached) return cached;

    const fallback = defaultFor(role, cat);
    let picked: { code: string; name: string } | undefined;

    // A bare `REVENUE` override retargets every category at once.
    const overrideCode = overrides[key] ?? overrides[role];
    if (overrideCode) {
      const known = byCode.get(overrideCode);
      picked = { code: overrideCode, name: known?.name ?? fallback.name };
    }

    if (!picked) {
      const tags = cat ? [`REVENUE:${cat}`, cat, ...CATEGORY_ALIASES.REVENUE] : CATEGORY_ALIASES[role];
      for (const tag of tags) {
        const match = byTag.get(normalizeCategoryTag(tag))?.[0];
        if (match) {
          picked = { code: match.code, name: match.name };
          break;
        }
      }
    }

    const ref: LedgerAccountRef = { ...(picked ?? fallback), role, ...(cat ? { category: cat } : {}) };
    cache.set(key, ref);
    return ref;
  }

  return {
    account: resolve,
    list() {
      const refs: LedgerAccountRef[] = ACTIVITY_CATEGORIES.map((c) => resolve('REVENUE', c));
      for (const role of Object.keys(DEFAULT_ROLE_ACCOUNTS) as (keyof typeof DEFAULT_ROLE_ACCOUNTS)[]) {
        refs.push(resolve(role));
      }
      return refs;
    },
  };
}

// ---------------------------------------------------------------------------
// Input rows
// ---------------------------------------------------------------------------

export type PaymentStatusKey =
  | 'PAID'
  | 'REFUNDED'
  | 'PARTIAL_REFUND'
  | 'FAILED'
  | 'PRE_AUTHORIZED'
  | 'REQUIRES_ACTION'
  | 'DISPUTED';

/**
 * Statuses where money actually moved. PRE_AUTHORIZED is a hold, not a capture;
 * REQUIRES_ACTION is an unfinished 3DS challenge; FAILED never took anything.
 * DISPUTED counts as captured because the charge did settle — the chargeback
 * reversal rides on `refundedCents`, so netting it twice would be wrong.
 */
export const CAPTURED_PAYMENT_STATUSES: readonly string[] = [
  'PAID',
  'REFUNDED',
  'PARTIAL_REFUND',
  'DISPUTED',
];

export function isCapturedPayment(status: string): boolean {
  return CAPTURED_PAYMENT_STATUSES.includes(status);
}

export interface ExportOrderItemRow {
  activityId: string;
  activityName: string;
  /** ActivityCategory; an unrecognized value maps to the OTHER revenue account. */
  category: string;
  quantity: number;
  unitPriceCents: number;
}

export interface ExportPaymentRow {
  paymentId: string;
  method: string;
  status: string;
  amountCents: number;
  refundedCents: number;
  processedAt: Date;
}

export interface ExportOrderRow {
  orderId: string;
  orderNumber: string;
  createdAt: Date;
  status: string;
  customerName: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  processingFeeCents: number;
  tipCents: number;
  totalCents: number;
  amountPaidCents: number;
  balanceDueCents: number;
  items: readonly ExportOrderItemRow[];
  payments: readonly ExportPaymentRow[];
}

/** A gift card / certificate SOLD in the window — creates a liability, not revenue. */
export interface GiftIssueRow {
  id: string;
  code: string;
  kind: 'GIFT_CARD' | 'GIFT_CERTIFICATE';
  issuedAt: Date;
  faceValueCents: number;
  /** How the purchase was paid for; defaults to CARD when unknown. */
  method?: string;
}

/** A gift card / certificate that expired or was voided — liability released to income. */
export interface GiftForfeitRow {
  id: string;
  code: string;
  kind: 'GIFT_CARD' | 'GIFT_CERTIFICATE';
  forfeitedAt: Date;
  amountCents: number;
}

/**
 * A payment that SETTLED inside the window regardless of its order's date. This
 * is the bank-statement side of the tie-out: orders taken on Friday but paid on
 * Saturday show up here on Saturday, and the reconciliation reports the gap
 * instead of pretending it does not exist.
 */
export interface SettlementRow {
  paymentId: string;
  method: string;
  status: string;
  amountCents: number;
  refundedCents: number;
  processedAt: Date;
}

export interface AccountingExportInput {
  /** Inclusive start / exclusive end, UTC instants. */
  periodStart: Date;
  periodEnd: Date;
  timeZone: string;
  operatorName: string;
  orders: readonly ExportOrderRow[];
  giftIssues?: readonly GiftIssueRow[];
  giftForfeits?: readonly GiftForfeitRow[];
  settlements?: readonly SettlementRow[];
  /** Gift-card + certificate liability immediately before the window opened. */
  openingGiftLiabilityCents?: number;
  accounts?: readonly GLAccountInput[];
  overrides?: ChartOverrides;
  /** Journal document number; defaults to `MBP-YYYYMMDD` from the period start. */
  journalNo?: string;
  /** Tax-report grouping. 'period' = one row for the whole window. */
  taxGranularity?: TaxGranularity;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export type AccountingIssueCode =
  | 'COMPOSITION_RESIDUAL'
  | 'PAID_MISMATCH'
  | 'BALANCE_MISMATCH'
  | 'OVER_REFUNDED'
  | 'NEGATIVE_RECEIVABLE'
  | 'JOURNAL_OUT_OF_BALANCE'
  | 'COLLECTION_VARIANCE'
  | 'SETTLEMENT_VARIANCE';

export interface AccountingIssue {
  code: AccountingIssueCode;
  severity: 'warning' | 'error';
  orderNumber?: string;
  message: string;
  /** The size of the discrepancy in cents (signed, direction is code-specific). */
  amountCents: number;
}

// ---------------------------------------------------------------------------
// Per-order derivation
// ---------------------------------------------------------------------------

export interface CategorySplit {
  category: string;
  grossCents: number;
  discountCents: number;
  netCents: number;
  refundCents: number;
  quantity: number;
}

export interface MethodSplit {
  method: PaymentMethodKey;
  capturedCents: number;
  refundedCents: number;
  netCents: number;
}

/** How a refund is put back across the components the customer originally paid. */
export interface RefundSplit {
  revenueCents: number;
  taxCents: number;
  feeCents: number;
  tipCents: number;
  otherCents: number;
  totalCents: number;
}

export interface OrderAccounting {
  orderId: string;
  orderNumber: string;
  createdAt: Date;
  status: string;
  customerName: string;
  grossCents: number;
  discountCents: number;
  netSalesCents: number;
  taxCents: number;
  processingFeeCents: number;
  tipCents: number;
  /**
   * `total − (net + tax + fee + tip)`. Pricing folds flat fees and percentage
   * surcharges into the taxable base without giving them a column on Order, so
   * a positive residual is a legitimate surcharge and posts to Other Charges.
   * A NEGATIVE residual cannot be explained that way and is raised as an issue.
   */
  otherChargesCents: number;
  totalCents: number;
  capturedCents: number;
  refundedCents: number;
  collectedNetCents: number;
  /** Derived as `total − captured`, NOT read from balance_due (which is checked). */
  receivableCents: number;
  taxableSalesCents: number;
  exemptSalesCents: number;
  byCategory: CategorySplit[];
  byMethod: MethodSplit[];
  refundSplit: RefundSplit;
  issues: AccountingIssue[];
}

function methodKey(raw: string): PaymentMethodKey {
  return (PAYMENT_METHOD_KEYS as string[]).includes(raw) ? (raw as PaymentMethodKey) : 'COMP';
}

function categoryKey(raw: string): string {
  const tag = normalizeCategoryTag(raw);
  return (ACTIVITY_CATEGORIES as readonly string[]).includes(tag) ? tag : 'OTHER';
}

/**
 * Reduce one order to its accounting shape. Everything is derived from the
 * component columns and then compared against the stored totals; the stored
 * value never overrides the derivation, it only produces an issue when the two
 * disagree. That ordering is deliberate — a corrupt `amount_paid_cents` should
 * show up on the reconciliation, not quietly become the truth.
 */
export function deriveOrderAccounting(order: ExportOrderRow): OrderAccounting {
  const label = `order ${order.orderNumber}`;
  const grossCents = assertCents(order.subtotalCents, `${label} subtotal`);
  const discountCents = assertCents(order.discountCents, `${label} discount`);
  const taxCents = assertCents(order.taxCents, `${label} tax`);
  const processingFeeCents = assertCents(order.processingFeeCents, `${label} processing fee`);
  const tipCents = assertCents(order.tipCents, `${label} tip`);
  const totalCents = assertCents(order.totalCents, `${label} total`);

  const netSalesCents = grossCents - discountCents;
  const otherChargesCents = totalCents - (netSalesCents + taxCents + processingFeeCents + tipCents);

  const issues: AccountingIssue[] = [];
  if (otherChargesCents < 0) {
    issues.push({
      code: 'COMPOSITION_RESIDUAL',
      severity: 'error',
      orderNumber: order.orderNumber,
      message: `Order total is ${centsToDecimal(-otherChargesCents)} less than the sum of its parts`,
      amountCents: otherChargesCents,
    });
  }

  // --- Payments -----------------------------------------------------------
  const methodTotals = new Map<PaymentMethodKey, MethodSplit>();
  for (const key of PAYMENT_METHOD_KEYS) {
    methodTotals.set(key, { method: key, capturedCents: 0, refundedCents: 0, netCents: 0 });
  }
  let capturedCents = 0;
  let refundedCents = 0;
  for (const p of order.payments) {
    const amount = assertCents(p.amountCents, `${label} payment amount`);
    const refunded = assertCents(p.refundedCents, `${label} payment refund`);
    if (!isCapturedPayment(p.status)) continue;
    const bucket = methodTotals.get(methodKey(p.method))!;
    bucket.capturedCents += amount;
    bucket.refundedCents += refunded;
    capturedCents += amount;
    refundedCents += refunded;
  }
  const byMethod = PAYMENT_METHOD_KEYS.map((key) => {
    const b = methodTotals.get(key)!;
    b.netCents = b.capturedCents - b.refundedCents;
    return b;
  });

  if (refundedCents > capturedCents) {
    issues.push({
      code: 'OVER_REFUNDED',
      severity: 'error',
      orderNumber: order.orderNumber,
      message: `Refunds (${centsToDecimal(refundedCents)}) exceed captured payments (${centsToDecimal(capturedCents)})`,
      amountCents: refundedCents - capturedCents,
    });
  }
  if (capturedCents !== order.amountPaidCents) {
    issues.push({
      code: 'PAID_MISMATCH',
      severity: 'warning',
      orderNumber: order.orderNumber,
      message: `Captured payments ${centsToDecimal(capturedCents)} do not match the order's amount paid ${centsToDecimal(order.amountPaidCents)}`,
      amountCents: capturedCents - order.amountPaidCents,
    });
  }

  const receivableCents = totalCents - capturedCents;
  if (receivableCents !== order.balanceDueCents) {
    issues.push({
      code: 'BALANCE_MISMATCH',
      severity: 'warning',
      orderNumber: order.orderNumber,
      message: `Derived balance due ${centsToDecimal(receivableCents)} does not match the stored ${centsToDecimal(order.balanceDueCents)}`,
      amountCents: receivableCents - order.balanceDueCents,
    });
  }
  if (receivableCents < 0) {
    issues.push({
      code: 'NEGATIVE_RECEIVABLE',
      severity: 'warning',
      orderNumber: order.orderNumber,
      message: `Order is overpaid by ${centsToDecimal(-receivableCents)}`,
      amountCents: receivableCents,
    });
  }

  // --- Refund split -------------------------------------------------------
  // Put the refund back across exactly the components the charge credited, so a
  // partial refund releases its share of the tax liability and the tip rather
  // than being charged entirely to revenue.
  const componentWeights = [
    Math.max(0, netSalesCents),
    Math.max(0, taxCents),
    Math.max(0, processingFeeCents),
    Math.max(0, tipCents),
    Math.max(0, otherChargesCents),
  ];
  const [rRevenue, rTax, rFee, rTip, rOther] = allocateProRata(refundedCents, componentWeights);
  const refundSplit: RefundSplit = {
    revenueCents: rRevenue,
    taxCents: rTax,
    feeCents: rFee,
    tipCents: rTip,
    otherCents: rOther,
    totalCents: refundedCents,
  };

  // --- Revenue by activity category --------------------------------------
  const catOrder: string[] = [];
  const catGross = new Map<string, { gross: number; quantity: number }>();
  for (const item of order.items) {
    const key = categoryKey(item.category);
    const line = assertCents(item.unitPriceCents, `${label} item price`) * Math.max(0, Math.trunc(item.quantity));
    const existing = catGross.get(key);
    if (existing) {
      existing.gross += line;
      existing.quantity += Math.max(0, Math.trunc(item.quantity));
    } else {
      catOrder.push(key);
      catGross.set(key, { gross: line, quantity: Math.max(0, Math.trunc(item.quantity)) });
    }
  }
  // An order with no items still carries money (a POS misc charge, a comped
  // booking whose lines were removed); park it on OTHER rather than lose it.
  if (catOrder.length === 0 && (grossCents !== 0 || totalCents !== 0)) {
    catOrder.push('OTHER');
    catGross.set('OTHER', { gross: grossCents, quantity: 0 });
  }

  const itemGrossTotal = catOrder.reduce((a, k) => a + catGross.get(k)!.gross, 0);
  // The order's stored subtotal is authoritative; if the item lines drift from
  // it (a manually adjusted order), scale the categories to the subtotal so
  // revenue by category always sums to gross sales.
  const grossWeights = catOrder.map((k) => catGross.get(k)!.gross);
  const grossParts =
    itemGrossTotal === grossCents ? grossWeights : allocateProRata(grossCents, grossWeights);
  const discountParts = allocateProRata(discountCents, grossParts);
  const refundParts = allocateProRata(rRevenue, grossParts);

  const byCategory: CategorySplit[] = catOrder.map((key, i) => ({
    category: key,
    grossCents: grossParts[i],
    discountCents: discountParts[i],
    netCents: grossParts[i] - discountParts[i],
    refundCents: refundParts[i],
    quantity: catGross.get(key)!.quantity,
  }));

  // --- Tax basis ----------------------------------------------------------
  // Pricing taxes `subtotal − discount + flat fees/surcharges`, and excludes the
  // processing fee (applied after tax) and tips (never taxed). An order with no
  // tax is treated as exempt rather than zero-rated so the remittance report can
  // show taxable and exempt sales separately, which is what the form asks for.
  const taxBase = netSalesCents + Math.max(0, otherChargesCents);
  const taxableSalesCents = taxCents > 0 ? taxBase : 0;
  const exemptSalesCents = taxCents > 0 ? 0 : taxBase;

  return {
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    createdAt: order.createdAt,
    status: order.status,
    customerName: order.customerName,
    grossCents,
    discountCents,
    netSalesCents,
    taxCents,
    processingFeeCents,
    tipCents,
    otherChargesCents,
    totalCents,
    capturedCents,
    refundedCents,
    collectedNetCents: capturedCents - refundedCents,
    receivableCents,
    taxableSalesCents,
    exemptSalesCents,
    byCategory,
    byMethod,
    refundSplit,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export interface JournalLine {
  accountCode: string;
  accountName: string;
  role: LedgerRole;
  /** Non-negative. Exactly one of debit/credit is non-zero on a given line. */
  debitCents: number;
  creditCents: number;
  memo: string;
  /** Tracking/class dimension — the activity category on revenue lines. */
  className?: string;
}

export interface JournalEntry {
  journalNo: string;
  /** The date the entry posts on: the last day of the window, operator-local. */
  date: Date;
  memo: string;
  lines: JournalLine[];
  debitsCents: number;
  creditsCents: number;
  balanced: boolean;
}

/** Post `amountCents` to an account: positive debits, negative credits. */
function post(
  lines: JournalLine[],
  ref: LedgerAccountRef,
  amountCents: number,
  memo: string,
): void {
  if (amountCents === 0) return;
  lines.push({
    accountCode: ref.code,
    accountName: ref.name,
    role: ref.role,
    debitCents: amountCents > 0 ? amountCents : 0,
    creditCents: amountCents < 0 ? -amountCents : 0,
    memo,
    ...(ref.category ? { className: ref.category } : {}),
  });
}

/** The account money lands in for a given payment method. */
function cashRoleFor(method: PaymentMethodKey): LedgerRole {
  switch (method) {
    case 'CARD':
      return 'UNDEPOSITED_FUNDS';
    case 'CASH':
      return 'CASH_ON_HAND';
    case 'GIFT_CARD':
      // A redemption is not cash coming in — it is a liability being discharged.
      return 'GIFT_LIABILITY';
    case 'COMP':
      // Comps recognize revenue and immediately offset it with contra-revenue,
      // so the P&L shows what was given away instead of hiding it.
      return 'COMPS';
  }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface Reconciliation {
  grossSalesCents: number;
  discountsCents: number;
  netSalesCents: number;
  taxCents: number;
  processingFeesCents: number;
  tipsCents: number;
  otherChargesCents: number;
  /** What we billed: the sum of order totals. */
  chargedCents: number;
  refundsCents: number;
  receivableCents: number;
  /** Captured minus refunded across every method, including gift card and comp. */
  collectedCents: number;
  /**
   * Card + cash taken against ORDERS. This is what the settlement figure is
   * compared to, because those are the two sides backed by Payment rows.
   */
  cashCollectedCents: number;
  /**
   * Card + cash taken for gift cards SOLD. Real money in the drawer, but it
   * belongs to no order and creates a liability rather than revenue, so it is
   * reported on its own line instead of being folded into collections.
   */
  giftCardSoldCents: number;
  giftCardRedeemedCents: number;
  compedCents: number;
  /**
   * gross − discounts + other + tax + fees + tips − refunds − receivable.
   * This is the identity a bookkeeper checks; `varianceCents` is how far the
   * actual collections fall from it, and it is REPORTED, never absorbed.
   */
  expectedCollectedCents: number;
  varianceCents: number;
  balanced: boolean;
  byMethod: MethodSplit[];
  debitsCents: number;
  creditsCents: number;
  /** Payments that settled in the window regardless of order date (bank tie-out). */
  settlementCents: number | null;
  settlementVarianceCents: number | null;
  orderCount: number;
  issues: AccountingIssue[];
}

// ---------------------------------------------------------------------------
// Tax remittance
// ---------------------------------------------------------------------------

export type TaxGranularity = 'day' | 'month' | 'period';

export interface TaxPeriodRow {
  periodKey: string;
  orders: number;
  grossSalesCents: number;
  discountsCents: number;
  taxableSalesCents: number;
  exemptSalesCents: number;
  taxCollectedCents: number;
  taxRefundedCents: number;
  /** Collected minus refunded — the number that goes on the return. */
  taxDueCents: number;
  /** taxDue / taxableSales as a percent, or null when there were no taxable sales. */
  effectiveRatePercent: number | null;
}

export interface TaxRemittanceReport {
  granularity: TaxGranularity;
  timeZone: string;
  rows: TaxPeriodRow[];
  totals: TaxPeriodRow;
}

// ---------------------------------------------------------------------------
// Gift card / certificate movement
// ---------------------------------------------------------------------------

export interface GiftActivity {
  issuedCents: number;
  issuedCount: number;
  redeemedCents: number;
  redeemedCount: number;
  forfeitedCents: number;
  forfeitedCount: number;
  /** issued − redeemed − forfeited: the period's change in liability. */
  netLiabilityChangeCents: number;
  openingLiabilityCents: number | null;
  closingLiabilityCents: number | null;
}

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

export interface AccountingExportResult {
  operatorName: string;
  periodStart: Date;
  periodEnd: Date;
  timeZone: string;
  chart: Chart;
  orders: OrderAccounting[];
  journal: JournalEntry;
  reconciliation: Reconciliation;
  tax: TaxRemittanceReport;
  gift: GiftActivity;
  revenueByCategory: CategorySplit[];
  issues: AccountingIssue[];
}

function emptyTaxRow(periodKey: string): TaxPeriodRow {
  return {
    periodKey,
    orders: 0,
    grossSalesCents: 0,
    discountsCents: 0,
    taxableSalesCents: 0,
    exemptSalesCents: 0,
    taxCollectedCents: 0,
    taxRefundedCents: 0,
    taxDueCents: 0,
    effectiveRatePercent: null,
  };
}

/** Effective rate to 4 decimal places — enough to spot a wrong rate, not noise. */
function effectiveRate(taxDueCents: number, taxableSalesCents: number): number | null {
  if (taxableSalesCents <= 0) return null;
  return Math.round((taxDueCents / taxableSalesCents) * 1_000_000) / 10_000;
}

/**
 * Build the whole accounting export for one period: the journal, the proof that
 * it reconciles, the tax remittance summary and the gift-card movement.
 *
 * The journal balances by construction — for every order,
 *   credits = gross + other + tax + fee + tip − (refund minus its revenue share)
 *   debits  = discount + refunded revenue + (captured − refunded) + receivable
 * and those two are algebraically equal given `total = gross − discount + other
 * + tax + fee + tip` and `receivable = total − captured`. If they ever are not,
 * the difference is posted to a visibly-named Suspense account and raised as an
 * error, because an export that silently drops a cent is worse than one that
 * announces it.
 */
export function buildAccountingExport(input: AccountingExportInput): AccountingExportResult {
  const chart = resolveChart({ accounts: input.accounts, overrides: input.overrides });
  const timeZone = input.timeZone || 'UTC';
  const orders = input.orders.map(deriveOrderAccounting);
  const issues: AccountingIssue[] = orders.flatMap((o) => o.issues);

  // --- Aggregate ----------------------------------------------------------
  const revenueByCategoryMap = new Map<string, CategorySplit>();
  const methodTotals = new Map<PaymentMethodKey, MethodSplit>();
  for (const key of PAYMENT_METHOD_KEYS) {
    methodTotals.set(key, { method: key, capturedCents: 0, refundedCents: 0, netCents: 0 });
  }

  let grossSalesCents = 0;
  let discountsCents = 0;
  let taxCents = 0;
  let processingFeesCents = 0;
  let tipsCents = 0;
  let otherChargesCents = 0;
  let chargedCents = 0;
  let refundsCents = 0;
  let receivableCents = 0;
  let capturedCents = 0;
  let refundRevenueCents = 0;
  let refundTaxCents = 0;
  let refundFeeCents = 0;
  let refundTipCents = 0;
  let refundOtherCents = 0;

  for (const o of orders) {
    grossSalesCents += o.grossCents;
    discountsCents += o.discountCents;
    taxCents += o.taxCents;
    processingFeesCents += o.processingFeeCents;
    tipsCents += o.tipCents;
    otherChargesCents += Math.max(0, o.otherChargesCents);
    chargedCents += o.totalCents;
    refundsCents += o.refundedCents;
    receivableCents += o.receivableCents;
    capturedCents += o.capturedCents;
    refundRevenueCents += o.refundSplit.revenueCents;
    refundTaxCents += o.refundSplit.taxCents;
    refundFeeCents += o.refundSplit.feeCents;
    refundTipCents += o.refundSplit.tipCents;
    refundOtherCents += o.refundSplit.otherCents;

    for (const c of o.byCategory) {
      const existing = revenueByCategoryMap.get(c.category);
      if (existing) {
        existing.grossCents += c.grossCents;
        existing.discountCents += c.discountCents;
        existing.netCents += c.netCents;
        existing.refundCents += c.refundCents;
        existing.quantity += c.quantity;
      } else {
        revenueByCategoryMap.set(c.category, { ...c });
      }
    }
    for (const m of o.byMethod) {
      const bucket = methodTotals.get(m.method)!;
      bucket.capturedCents += m.capturedCents;
      bucket.refundedCents += m.refundedCents;
    }
  }

  const byMethod = PAYMENT_METHOD_KEYS.map((key) => {
    const b = methodTotals.get(key)!;
    b.netCents = b.capturedCents - b.refundedCents;
    return b;
  });

  const revenueByCategory = Array.from(revenueByCategoryMap.values()).sort(
    (a, b) => b.grossCents - a.grossCents || a.category.localeCompare(b.category),
  );

  // --- Gift movement ------------------------------------------------------
  const giftIssues = input.giftIssues ?? [];
  const giftForfeits = input.giftForfeits ?? [];
  const giftRedeemed = methodTotals.get('GIFT_CARD')!;
  const issuedCents = giftIssues.reduce(
    (a, g) => a + assertCents(g.faceValueCents, `gift ${g.code} face value`),
    0,
  );
  const forfeitedCents = giftForfeits.reduce(
    (a, g) => a + assertCents(g.amountCents, `gift ${g.code} forfeit`),
    0,
  );
  const redeemedNetCents = giftRedeemed.capturedCents - giftRedeemed.refundedCents;
  const openingLiabilityCents = input.openingGiftLiabilityCents ?? null;
  const netLiabilityChangeCents = issuedCents - redeemedNetCents - forfeitedCents;
  const gift: GiftActivity = {
    issuedCents,
    issuedCount: giftIssues.length,
    redeemedCents: redeemedNetCents,
    redeemedCount: orders.filter((o) => o.byMethod.some((m) => m.method === 'GIFT_CARD' && m.capturedCents > 0))
      .length,
    forfeitedCents,
    forfeitedCount: giftForfeits.length,
    netLiabilityChangeCents,
    openingLiabilityCents,
    closingLiabilityCents:
      openingLiabilityCents === null ? null : openingLiabilityCents + netLiabilityChangeCents,
  };

  // --- Journal ------------------------------------------------------------
  const periodLabel = `${formatDateInZone(input.periodStart, timeZone, 'ISO')} – ${formatDateInZone(
    new Date(input.periodEnd.getTime() - 1),
    timeZone,
    'ISO',
  )}`;
  const memo = `${input.operatorName} sales ${periodLabel}`;
  const lines: JournalLine[] = [];

  // Credits — what the sale earned or owes.
  for (const c of revenueByCategory) {
    post(lines, chart.account('REVENUE', c.category), -c.grossCents, `${c.category} gross sales`);
  }
  post(lines, chart.account('OTHER_CHARGES'), -(otherChargesCents - refundOtherCents), 'Surcharges, net of refunds');
  post(lines, chart.account('SALES_TAX_PAYABLE'), -(taxCents - refundTaxCents), 'Sales tax collected, net of refunds');
  post(
    lines,
    chart.account('PROCESSING_FEE_INCOME'),
    -(processingFeesCents - refundFeeCents),
    'Processing fees charged, net of refunds',
  );
  post(lines, chart.account('TIPS_PAYABLE'), -(tipsCents - refundTipCents), 'Tips owed to staff, net of refunds');

  // Debits — contra-revenue and where the money went.
  post(lines, chart.account('DISCOUNTS'), discountsCents, 'Promotional discounts');
  post(lines, chart.account('REFUNDS'), refundRevenueCents, 'Refunded sales (revenue portion)');
  for (const m of byMethod) {
    post(lines, chart.account(cashRoleFor(m.method)), m.netCents, `${m.method} collected, net of refunds`);
  }
  post(lines, chart.account('ACCOUNTS_RECEIVABLE'), receivableCents, 'Balance due on open orders');

  // Gift cards sold create a liability; the cash side lands with its method.
  if (giftIssues.length > 0) {
    const issuedByMethod = new Map<PaymentMethodKey, number>();
    for (const g of giftIssues) {
      const key = methodKey(g.method ?? 'CARD');
      issuedByMethod.set(key, (issuedByMethod.get(key) ?? 0) + g.faceValueCents);
    }
    for (const [method, amount] of issuedByMethod) {
      post(lines, chart.account(cashRoleFor(method)), amount, `Gift cards sold (${method})`);
    }
    post(lines, chart.account('GIFT_LIABILITY'), -issuedCents, 'Gift cards sold — liability created');
  }
  if (forfeitedCents !== 0) {
    post(lines, chart.account('GIFT_LIABILITY'), forfeitedCents, 'Expired/voided gift cards');
    post(lines, chart.account('GIFT_BREAKAGE'), -forfeitedCents, 'Gift card breakage income');
  }

  let debitsCents = lines.reduce((a, l) => a + l.debitCents, 0);
  let creditsCents = lines.reduce((a, l) => a + l.creditCents, 0);
  if (debitsCents !== creditsCents) {
    const plug = creditsCents - debitsCents;
    post(lines, chart.account('SUSPENSE'), plug, 'Unreconciled difference — investigate before posting');
    issues.push({
      code: 'JOURNAL_OUT_OF_BALANCE',
      severity: 'error',
      message: `Journal did not balance; ${centsToDecimal(Math.abs(plug))} posted to Suspense`,
      amountCents: plug,
    });
    debitsCents = lines.reduce((a, l) => a + l.debitCents, 0);
    creditsCents = lines.reduce((a, l) => a + l.creditCents, 0);
  }

  const journal: JournalEntry = {
    journalNo: input.journalNo ?? `MBP-${formatDateInZone(input.periodStart, timeZone, 'ISO').replace(/-/g, '')}`,
    // Post on the last instant inside the window so a month's entry lands in
    // that month rather than on the first of the next one.
    date: new Date(input.periodEnd.getTime() - 1),
    memo,
    lines,
    debitsCents,
    creditsCents,
    balanced: debitsCents === creditsCents,
  };

  // --- Reconciliation -----------------------------------------------------
  const collectedCents = capturedCents - refundsCents;
  const cashCollectedCents = byMethod
    .filter((m) => m.method === 'CARD' || m.method === 'CASH')
    .reduce((a, m) => a + m.netCents, 0);
  const expectedCollectedCents =
    grossSalesCents -
    discountsCents +
    otherChargesCents +
    taxCents +
    processingFeesCents +
    tipsCents -
    refundsCents -
    receivableCents;
  const varianceCents = expectedCollectedCents - collectedCents;
  if (varianceCents !== 0) {
    issues.push({
      code: 'COLLECTION_VARIANCE',
      severity: 'error',
      message: `Expected collections ${centsToDecimal(expectedCollectedCents)} do not match actual ${centsToDecimal(collectedCents)}`,
      amountCents: varianceCents,
    });
  }

  let settlementCents: number | null = null;
  let settlementVarianceCents: number | null = null;
  if (input.settlements) {
    settlementCents = input.settlements.reduce((acc, s) => {
      if (!isCapturedPayment(s.status)) return acc;
      const key = methodKey(s.method);
      if (key !== 'CARD' && key !== 'CASH') return acc;
      return acc + assertCents(s.amountCents, 'settlement amount') - assertCents(s.refundedCents, 'settlement refund');
    }, 0);
    settlementVarianceCents = settlementCents - cashCollectedCents;
    if (settlementVarianceCents !== 0) {
      issues.push({
        code: 'SETTLEMENT_VARIANCE',
        severity: 'warning',
        message:
          `${centsToDecimal(Math.abs(settlementVarianceCents))} settled in this window against orders dated outside it ` +
          '(deposits paid later, or balances collected on an earlier order)',
        amountCents: settlementVarianceCents,
      });
    }
  }

  const reconciliation: Reconciliation = {
    grossSalesCents,
    discountsCents,
    netSalesCents: grossSalesCents - discountsCents,
    taxCents,
    processingFeesCents,
    tipsCents,
    otherChargesCents,
    chargedCents,
    refundsCents,
    receivableCents,
    collectedCents,
    cashCollectedCents,
    giftCardSoldCents: giftIssues.reduce((a, g) => {
      const key = methodKey(g.method ?? 'CARD');
      return key === 'CARD' || key === 'CASH' ? a + g.faceValueCents : a;
    }, 0),
    giftCardRedeemedCents: methodTotals.get('GIFT_CARD')!.netCents,
    compedCents: methodTotals.get('COMP')!.netCents,
    expectedCollectedCents,
    varianceCents,
    balanced: varianceCents === 0 && debitsCents === creditsCents,
    byMethod,
    debitsCents,
    creditsCents,
    settlementCents,
    settlementVarianceCents,
    orderCount: orders.length,
    issues,
  };

  // --- Tax remittance -----------------------------------------------------
  const granularity: TaxGranularity = input.taxGranularity ?? 'day';
  const taxRows = new Map<string, TaxPeriodRow>();
  for (const o of orders) {
    const key =
      granularity === 'day'
        ? zonedDayKey(o.createdAt, timeZone)
        : granularity === 'month'
          ? zonedMonthKey(o.createdAt, timeZone)
          : periodLabel;
    let row = taxRows.get(key);
    if (!row) {
      row = emptyTaxRow(key);
      taxRows.set(key, row);
    }
    row.orders += 1;
    row.grossSalesCents += o.grossCents;
    row.discountsCents += o.discountCents;
    row.taxableSalesCents += o.taxableSalesCents;
    row.exemptSalesCents += o.exemptSalesCents;
    row.taxCollectedCents += o.taxCents;
    row.taxRefundedCents += o.refundSplit.taxCents;
  }
  const rows = Array.from(taxRows.values()).sort((a, b) => a.periodKey.localeCompare(b.periodKey));
  const totals = emptyTaxRow(periodLabel);
  for (const row of rows) {
    row.taxDueCents = row.taxCollectedCents - row.taxRefundedCents;
    row.effectiveRatePercent = effectiveRate(row.taxDueCents, row.taxableSalesCents);
    totals.orders += row.orders;
    totals.grossSalesCents += row.grossSalesCents;
    totals.discountsCents += row.discountsCents;
    totals.taxableSalesCents += row.taxableSalesCents;
    totals.exemptSalesCents += row.exemptSalesCents;
    totals.taxCollectedCents += row.taxCollectedCents;
    totals.taxRefundedCents += row.taxRefundedCents;
  }
  totals.taxDueCents = totals.taxCollectedCents - totals.taxRefundedCents;
  totals.effectiveRatePercent = effectiveRate(totals.taxDueCents, totals.taxableSalesCents);

  return {
    operatorName: input.operatorName,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    timeZone,
    chart,
    orders,
    journal,
    reconciliation,
    tax: { granularity, timeZone, rows, totals },
    gift,
    revenueByCategory,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export type CsvCell = string | number | null | undefined;

/** RFC-4180 quoting: wrap on comma, quote or newline; double internal quotes. */
export function csvEscape(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'number' ? String(value) : value;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header + rows to a CRLF-delimited CSV string. */
export function serializeCsv(header: readonly string[], rows: readonly CsvCell[][]): string {
  return [header.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\r\n');
}

/** UTF-8 BOM, so Excel opens an export without mangling accented names. */
export const CSV_BOM = '﻿';

/**
 * QuickBooks Online journal-entry import. QBO keys lines by account NAME (not
 * code), so the name is what has to match the operator's chart; the code rides
 * along in the description for a human cross-check.
 */
export function toQuickBooksJournalCsv(
  entry: JournalEntry,
  opts: { timeZone: string; currency?: string },
): string {
  const date = formatDateInZone(entry.date, opts.timeZone, 'US');
  const currency = opts.currency ?? 'USD';
  const header = [
    '*JournalNo',
    '*JournalDate',
    '*Currency',
    'Memo',
    '*AccountName',
    'Debits',
    'Credits',
    'Description',
    'Name',
    'Location',
    'Class',
  ];
  const rows = entry.lines.map((l) => [
    entry.journalNo,
    date,
    currency,
    entry.memo,
    l.accountName,
    l.debitCents ? centsToDecimal(l.debitCents) : '',
    l.creditCents ? centsToDecimal(l.creditCents) : '',
    `${l.accountCode} — ${l.memo}`,
    '',
    '',
    l.className ?? '',
  ]);
  return serializeCsv(header, rows);
}

/** IIF fields are tab-delimited and cannot contain tabs or newlines. */
function iifCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').trim();
}

/**
 * QuickBooks Desktop IIF general journal. One TRNS line opens the transaction,
 * every remaining line is a SPL, and ENDTRNS closes it. Amounts are signed
 * dollars: debits positive, credits negative.
 */
export function toQuickBooksIif(entry: JournalEntry, opts: { timeZone: string }): string {
  const date = formatDateInZone(entry.date, opts.timeZone, 'US');
  const cols = ['TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'CLASS', 'AMOUNT', 'DOCNUM', 'MEMO'];
  const out: string[] = [
    ['!TRNS', ...cols].join('\t'),
    ['!SPL', ...cols].join('\t'),
    '!ENDTRNS',
  ];
  if (entry.lines.length > 0) {
    entry.lines.forEach((l, i) => {
      const amount = centsToDecimal(l.debitCents - l.creditCents);
      out.push(
        [
          i === 0 ? 'TRNS' : 'SPL',
          'GENERAL JOURNAL',
          date,
          iifCell(l.accountName),
          '',
          iifCell(l.className ?? ''),
          amount,
          iifCell(entry.journalNo),
          iifCell(l.memo),
        ].join('\t'),
      );
    });
    out.push('ENDTRNS');
  }
  // IIF requires a trailing newline or QuickBooks drops the last record.
  return `${out.join('\r\n')}\r\n`;
}

/**
 * Xero manual-journal import. Xero keys on account CODE and takes a single
 * signed Amount column (positive = debit, negative = credit). Tax is posted as
 * its own GL line here, so every line imports at the no-tax rate — otherwise
 * Xero would compute tax on top of tax we already collected.
 */
export function toXeroManualJournalCsv(
  entry: JournalEntry,
  opts: { timeZone: string; taxRate?: string },
): string {
  const date = formatDateInZone(entry.date, opts.timeZone, 'ISO');
  const taxRate = opts.taxRate ?? 'No Tax';
  const header = [
    '*Narration',
    '*Date',
    'Description',
    '*AccountCode',
    '*TaxRate',
    '*Amount',
    'TrackingName1',
    'TrackingOption1',
  ];
  const rows = entry.lines.map((l) => [
    entry.memo,
    date,
    l.memo,
    l.accountCode,
    taxRate,
    centsToDecimal(l.debitCents - l.creditCents),
    l.className ? 'Category' : '',
    l.className ?? '',
  ]);
  return serializeCsv(header, rows);
}

/** Per-period tax remittance — taxable sales, exempt sales, and tax due. */
export function toTaxRemittanceCsv(report: TaxRemittanceReport): string {
  const header = [
    'Period',
    'Orders',
    'Gross sales',
    'Discounts',
    'Taxable sales',
    'Exempt sales',
    'Tax collected',
    'Tax refunded',
    'Tax due',
    'Effective rate %',
  ];
  const toRow = (r: TaxPeriodRow): CsvCell[] => [
    r.periodKey,
    r.orders,
    centsToDecimal(r.grossSalesCents),
    centsToDecimal(r.discountsCents),
    centsToDecimal(r.taxableSalesCents),
    centsToDecimal(r.exemptSalesCents),
    centsToDecimal(r.taxCollectedCents),
    centsToDecimal(r.taxRefundedCents),
    centsToDecimal(r.taxDueCents),
    r.effectiveRatePercent === null ? '' : r.effectiveRatePercent.toFixed(4),
  ];
  return serializeCsv(header, [...report.rows.map(toRow), toRow({ ...report.totals, periodKey: 'TOTAL' })]);
}

/**
 * The reconciliation as a two-column statement, ending with the identity check.
 * A bookkeeper reads this top to bottom and either sees a zero variance or sees
 * exactly which line is off.
 */
export function toReconciliationCsv(r: Reconciliation): string {
  const rows: CsvCell[][] = [
    ['Gross sales', centsToDecimal(r.grossSalesCents)],
    ['Less discounts', centsToDecimal(-r.discountsCents)],
    ['Net sales', centsToDecimal(r.netSalesCents)],
    ['Plus other charges', centsToDecimal(r.otherChargesCents)],
    ['Plus sales tax', centsToDecimal(r.taxCents)],
    ['Plus processing fees', centsToDecimal(r.processingFeesCents)],
    ['Plus tips (liability)', centsToDecimal(r.tipsCents)],
    ['Total charged', centsToDecimal(r.chargedCents)],
    ['Less refunds', centsToDecimal(-r.refundsCents)],
    ['Less balance due (A/R)', centsToDecimal(-r.receivableCents)],
    ['Expected collected', centsToDecimal(r.expectedCollectedCents)],
    ['Actual collected', centsToDecimal(r.collectedCents)],
    ['Variance', centsToDecimal(r.varianceCents)],
    ['', ''],
    ...r.byMethod.map((m): CsvCell[] => [`Collected — ${m.method}`, centsToDecimal(m.netCents)]),
    ['Cash + card collected on orders', centsToDecimal(r.cashCollectedCents)],
    ['Gift cards sold (cash + card)', centsToDecimal(r.giftCardSoldCents)],
    ['Expected bank deposit', centsToDecimal(r.cashCollectedCents + r.giftCardSoldCents)],
    ['Settled in window (bank)', r.settlementCents === null ? '' : centsToDecimal(r.settlementCents)],
    [
      'Settlement variance',
      r.settlementVarianceCents === null ? '' : centsToDecimal(r.settlementVarianceCents),
    ],
    ['', ''],
    ['Journal debits', centsToDecimal(r.debitsCents)],
    ['Journal credits', centsToDecimal(r.creditsCents)],
    ['Orders', r.orderCount],
    ['Balanced', r.balanced ? 'YES' : 'NO'],
  ];
  return serializeCsv(['Line', 'Amount'], rows);
}

/** Order-level detail, so any journal line can be traced back to its orders. */
export function toOrderDetailCsv(orders: readonly OrderAccounting[], timeZone: string): string {
  const header = [
    'Order',
    'Date',
    'Status',
    'Customer',
    'Gross',
    'Discount',
    'Net sales',
    'Other charges',
    'Tax',
    'Processing fee',
    'Tip',
    'Total',
    'Captured',
    'Refunded',
    'Collected net',
    'Balance due',
    'Taxable sales',
    'Exempt sales',
    'Categories',
  ];
  const rows = orders.map((o): CsvCell[] => [
    o.orderNumber,
    formatDateInZone(o.createdAt, timeZone, 'ISO'),
    o.status,
    o.customerName,
    centsToDecimal(o.grossCents),
    centsToDecimal(o.discountCents),
    centsToDecimal(o.netSalesCents),
    centsToDecimal(o.otherChargesCents),
    centsToDecimal(o.taxCents),
    centsToDecimal(o.processingFeeCents),
    centsToDecimal(o.tipCents),
    centsToDecimal(o.totalCents),
    centsToDecimal(o.capturedCents),
    centsToDecimal(o.refundedCents),
    centsToDecimal(o.collectedNetCents),
    centsToDecimal(o.receivableCents),
    centsToDecimal(o.taxableSalesCents),
    centsToDecimal(o.exemptSalesCents),
    o.byCategory.map((c) => `${c.category}:${centsToDecimal(c.netCents)}`).join(' '),
  ]);
  return serializeCsv(header, rows);
}

/** Revenue by activity category, gross / discount / net / refunds. */
export function toRevenueByCategoryCsv(rows: readonly CategorySplit[]): string {
  const header = ['Category', 'Units', 'Gross', 'Discounts', 'Net', 'Refunded'];
  return serializeCsv(
    header,
    rows.map((r): CsvCell[] => [
      r.category,
      r.quantity,
      centsToDecimal(r.grossCents),
      centsToDecimal(r.discountCents),
      centsToDecimal(r.netCents),
      centsToDecimal(r.refundCents),
    ]),
  );
}

/** Issued vs redeemed vs forfeited, and the resulting liability. */
export function toGiftLiabilityCsv(gift: GiftActivity): string {
  const rows: CsvCell[][] = [
    ['Opening liability', gift.openingLiabilityCents === null ? '' : centsToDecimal(gift.openingLiabilityCents)],
    ['Issued', centsToDecimal(gift.issuedCents)],
    ['Redeemed', centsToDecimal(-gift.redeemedCents)],
    ['Forfeited (breakage)', centsToDecimal(-gift.forfeitedCents)],
    ['Net change', centsToDecimal(gift.netLiabilityChangeCents)],
    ['Closing liability', gift.closingLiabilityCents === null ? '' : centsToDecimal(gift.closingLiabilityCents)],
    ['Cards issued', gift.issuedCount],
    ['Orders using a gift card', gift.redeemedCount],
    ['Cards forfeited', gift.forfeitedCount],
  ];
  return serializeCsv(['Line', 'Amount'], rows);
}

/** Every variance the run found, so nothing is only visible in a log. */
export function toIssuesCsv(issues: readonly AccountingIssue[]): string {
  return serializeCsv(
    ['Severity', 'Code', 'Order', 'Amount', 'Detail'],
    issues.map((i): CsvCell[] => [i.severity, i.code, i.orderNumber ?? '', centsToDecimal(i.amountCents), i.message]),
  );
}

export type ExportFormat =
  | 'quickbooks-csv'
  | 'quickbooks-iif'
  | 'xero-csv'
  | 'tax-csv'
  | 'reconciliation-csv'
  | 'detail-csv'
  | 'revenue-csv'
  | 'gift-csv'
  | 'issues-csv';

export const EXPORT_FORMATS: ExportFormat[] = [
  'quickbooks-csv',
  'quickbooks-iif',
  'xero-csv',
  'tax-csv',
  'reconciliation-csv',
  'detail-csv',
  'revenue-csv',
  'gift-csv',
  'issues-csv',
];

/** Serialize a finished export into one of the supported file shapes. */
export function serializeExport(result: AccountingExportResult, format: ExportFormat): string {
  switch (format) {
    case 'quickbooks-csv':
      return toQuickBooksJournalCsv(result.journal, { timeZone: result.timeZone });
    case 'quickbooks-iif':
      return toQuickBooksIif(result.journal, { timeZone: result.timeZone });
    case 'xero-csv':
      return toXeroManualJournalCsv(result.journal, { timeZone: result.timeZone });
    case 'tax-csv':
      return toTaxRemittanceCsv(result.tax);
    case 'reconciliation-csv':
      return toReconciliationCsv(result.reconciliation);
    case 'detail-csv':
      return toOrderDetailCsv(result.orders, result.timeZone);
    case 'revenue-csv':
      return toRevenueByCategoryCsv(result.revenueByCategory);
    case 'gift-csv':
      return toGiftLiabilityCsv(result.gift);
    case 'issues-csv':
      return toIssuesCsv(result.issues);
  }
}

/** MIME type for a format — IIF is tab-delimited plain text, not CSV. */
export function exportContentType(format: ExportFormat): string {
  return format === 'quickbooks-iif' ? 'text/plain; charset=utf-8' : 'text/csv; charset=utf-8';
}

/** `marina_quickbooks-csv_2026-06-01_2026-06-30.csv`. */
export function exportFilename(format: ExportFormat, start: string, end: string): string {
  const ext = format === 'quickbooks-iif' ? 'iif' : 'csv';
  return `marina_${format.replace(/-(csv|iif)$/, '')}_${start}_${end}.${ext}`;
}
