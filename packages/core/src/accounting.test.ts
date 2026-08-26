import { describe, expect, it } from 'vitest';
import {
  AccountingError,
  allocateProRata,
  buildAccountingExport,
  centsToDecimal,
  csvEscape,
  deriveOrderAccounting,
  exportFilename,
  formatDateInZone,
  isCapturedPayment,
  resolveChart,
  serializeExport,
  toQuickBooksIif,
  toQuickBooksJournalCsv,
  toXeroManualJournalCsv,
  zonedDayKey,
  type ExportOrderItemRow,
  type ExportOrderRow,
  type ExportPaymentRow,
  type GiftIssueRow,
} from './accounting.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TZ = 'America/Los_Angeles';
// Midnight-to-midnight Pacific on 2026-06-15 (PDT = UTC-7).
const DAY_START = new Date('2026-06-15T07:00:00.000Z');
const DAY_END = new Date('2026-06-16T07:00:00.000Z');
const NOON = new Date('2026-06-15T19:00:00.000Z');

function item(
  category: string,
  unitPriceCents: number,
  quantity = 1,
): ExportOrderItemRow {
  return {
    activityId: `act-${category.toLowerCase()}`,
    activityName: `${category} rental`,
    category,
    quantity,
    unitPriceCents,
  };
}

function payment(
  method: string,
  amountCents: number,
  refundedCents = 0,
  status = refundedCents === 0 ? 'PAID' : refundedCents === amountCents ? 'REFUNDED' : 'PARTIAL_REFUND',
): ExportPaymentRow {
  return {
    paymentId: `pay-${method}-${amountCents}-${refundedCents}`,
    method,
    status,
    amountCents,
    refundedCents,
    processedAt: NOON,
  };
}

/**
 * Build an internally-consistent order: total is derived from the components
 * and amount paid / balance due from the captured payments, so any issue a test
 * sees is the one that test deliberately introduced.
 */
function makeOrder(input: {
  number: string;
  items: ExportOrderItemRow[];
  discountCents?: number;
  taxCents?: number;
  processingFeeCents?: number;
  tipCents?: number;
  otherChargesCents?: number;
  payments?: ExportPaymentRow[];
  createdAt?: Date;
  status?: string;
  overrides?: Partial<ExportOrderRow>;
}): ExportOrderRow {
  const subtotalCents = input.items.reduce((a, i) => a + i.unitPriceCents * i.quantity, 0);
  const discountCents = input.discountCents ?? 0;
  const taxCents = input.taxCents ?? 0;
  const processingFeeCents = input.processingFeeCents ?? 0;
  const tipCents = input.tipCents ?? 0;
  const other = input.otherChargesCents ?? 0;
  const totalCents = subtotalCents - discountCents + taxCents + processingFeeCents + tipCents + other;
  const payments = input.payments ?? [];
  const captured = payments
    .filter((p) => isCapturedPayment(p.status))
    .reduce((a, p) => a + p.amountCents, 0);
  return {
    orderId: `ord-${input.number}`,
    orderNumber: input.number,
    createdAt: input.createdAt ?? NOON,
    status: input.status ?? 'COMPLETED',
    customerName: 'Casey Rivers',
    subtotalCents,
    discountCents,
    taxCents,
    processingFeeCents,
    tipCents,
    totalCents,
    amountPaidCents: captured,
    balanceDueCents: totalCents - captured,
    items: input.items,
    payments,
    ...input.overrides,
  };
}

function build(orders: ExportOrderRow[], extra: Partial<Parameters<typeof buildAccountingExport>[0]> = {}) {
  return buildAccountingExport({
    periodStart: DAY_START,
    periodEnd: DAY_END,
    timeZone: TZ,
    operatorName: 'Lake Sonoma Marina',
    orders,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// allocateProRata — the only rounding rule in the accounting layer
// ---------------------------------------------------------------------------

describe('allocateProRata', () => {
  it('splits exactly, with no cent created or destroyed', () => {
    const parts = allocateProRata(1001, [6000, 4000]);
    expect(parts).toEqual([601, 400]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1001);
  });

  it('gives the leftover cent to the largest remainder, ties to the lower index', () => {
    expect(allocateProRata(1, [1, 1])).toEqual([1, 0]);
    expect(allocateProRata(10, [1, 1, 1])).toEqual([4, 3, 3]);
  });

  it('divides evenly when the split is exact', () => {
    expect(allocateProRata(3, [1, 1, 1])).toEqual([1, 1, 1]);
    expect(allocateProRata(5000, [9000, 900, 0, 100, 0])).toEqual([4500, 450, 0, 50, 0]);
  });

  it('allocates a negative amount the same way the charge was allocated', () => {
    expect(allocateProRata(-5, [1, 1])).toEqual([-3, -2]);
    expect(allocateProRata(-1001, [6000, 4000])).toEqual([-601, -400]);
  });

  it('spreads evenly when every weight is zero, rather than dropping the money', () => {
    const parts = allocateProRata(5, [0, 0, 0]);
    expect(parts).toEqual([2, 2, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('treats negative and non-finite weights as zero', () => {
    expect(allocateProRata(100, [-50, 100])).toEqual([0, 100]);
    expect(allocateProRata(100, [Number.NaN, 100])).toEqual([0, 100]);
  });

  it('returns nothing for no buckets, and zeros for a zero amount', () => {
    expect(allocateProRata(500, [])).toEqual([]);
    expect(allocateProRata(0, [3, 7])).toEqual([0, 0]);
  });

  it('stays exact across many buckets of awkward size', () => {
    const weights = [333, 333, 334, 1, 7, 19];
    const parts = allocateProRata(99_999, weights);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(99_999);
    expect(parts.every(Number.isInteger)).toBe(true);
  });

  it('refuses a fractional amount instead of silently rounding it', () => {
    expect(() => allocateProRata(10.5, [1, 1])).toThrow(AccountingError);
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('centsToDecimal', () => {
  it('renders whole dollars and cents', () => {
    expect(centsToDecimal(0)).toBe('0.00');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(50)).toBe('0.50');
    expect(centsToDecimal(123_405)).toBe('1234.05');
  });

  it('renders negatives with the sign in front of the dollars', () => {
    expect(centsToDecimal(-1)).toBe('-0.01');
    expect(centsToDecimal(-123_405)).toBe('-1234.05');
  });

  it('never produces a float artifact', () => {
    // 0.1 + 0.2 territory: 8_070_450_532_247_929 cents would break naive /100.
    expect(centsToDecimal(1_000_000_003)).toBe('10000000.03');
  });
});

describe('timezone handling', () => {
  it('attributes a late-evening order to the operator local day, not UTC', () => {
    const latePacific = new Date('2026-06-16T05:30:00.000Z'); // 22:30 on the 15th PDT
    expect(zonedDayKey(latePacific, TZ)).toBe('2026-06-15');
    expect(zonedDayKey(latePacific, 'UTC')).toBe('2026-06-16');
  });

  it('formats US dates for QuickBooks and ISO for Xero', () => {
    expect(formatDateInZone(NOON, TZ, 'US')).toBe('06/15/2026');
    expect(formatDateInZone(NOON, TZ, 'ISO')).toBe('2026-06-15');
  });

  it('falls back to UTC for an unusable timezone instead of throwing', () => {
    expect(zonedDayKey(NOON, 'Not/AZone')).toBe('2026-06-15');
  });
});

describe('csvEscape', () => {
  it('quotes only what needs quoting', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

describe('resolveChart', () => {
  it('uses the built-in chart when the operator has none', () => {
    const chart = resolveChart();
    expect(chart.account('REVENUE', 'BOAT')).toMatchObject({ code: '4010', role: 'REVENUE' });
    expect(chart.account('TIPS_PAYABLE')).toMatchObject({ code: '2300', name: 'Tips Payable' });
    expect(chart.account('GIFT_LIABILITY').code).toBe('2400');
  });

  it('maps an unknown activity category to Other Revenue rather than dropping it', () => {
    expect(resolveChart().account('REVENUE', 'SUBMARINE').code).toBe('4090');
  });

  it('honours an operator GLAccount tagged with the coarse schema categories', () => {
    const chart = resolveChart({
      accounts: [
        { code: '2050', name: 'CA Sales Tax', category: 'TAX' },
        { code: '4700', name: 'Card Surcharge Income', category: 'FEE' },
      ],
    });
    expect(chart.account('SALES_TAX_PAYABLE')).toMatchObject({ code: '2050', name: 'CA Sales Tax' });
    expect(chart.account('PROCESSING_FEE_INCOME').code).toBe('4700');
  });

  it('breaks a category tie on the lowest code so two runs agree', () => {
    const chart = resolveChart({
      accounts: [
        { code: '2299', name: 'Tax B', category: 'TAX' },
        { code: '2201', name: 'Tax A', category: 'TAX' },
      ],
    });
    expect(chart.account('SALES_TAX_PAYABLE').code).toBe('2201');
  });

  it('ignores inactive accounts', () => {
    const chart = resolveChart({
      accounts: [{ code: '2050', name: 'Old Tax', category: 'TAX', is_active: false }],
    });
    expect(chart.account('SALES_TAX_PAYABLE').code).toBe('2200');
  });

  it('lets a per-run override win over both the chart and the default', () => {
    const chart = resolveChart({
      accounts: [{ code: '4444', name: 'Charters', category: 'REVENUE' }],
      overrides: { 'REVENUE:BOAT': '4444', SALES_TAX_PAYABLE: '2075' },
    });
    expect(chart.account('REVENUE', 'BOAT')).toMatchObject({ code: '4444', name: 'Charters' });
    expect(chart.account('SALES_TAX_PAYABLE')).toMatchObject({ code: '2075', name: 'Sales Tax Payable' });
  });
});

// ---------------------------------------------------------------------------
// Per-order derivation
// ---------------------------------------------------------------------------

describe('deriveOrderAccounting', () => {
  it('decomposes a clean order and raises no issues', () => {
    const o = deriveOrderAccounting(
      makeOrder({
        number: 'A-1',
        items: [item('BOAT', 20_000)],
        taxCents: 1_750,
        processingFeeCents: 653,
        tipCents: 2_000,
        payments: [payment('CARD', 24_403)],
      }),
    );
    expect(o.grossCents).toBe(20_000);
    expect(o.netSalesCents).toBe(20_000);
    expect(o.otherChargesCents).toBe(0);
    expect(o.totalCents).toBe(24_403);
    expect(o.capturedCents).toBe(24_403);
    expect(o.receivableCents).toBe(0);
    expect(o.issues).toEqual([]);
  });

  it('splits an order-level discount across categories so the parts sum to the discount', () => {
    const o = deriveOrderAccounting(
      makeOrder({
        number: 'A-2',
        items: [item('BOAT', 6_000), item('TOUR', 4_000)],
        discountCents: 1_001,
        payments: [payment('CARD', 8_999)],
      }),
    );
    expect(o.byCategory.map((c) => [c.category, c.grossCents, c.discountCents])).toEqual([
      ['BOAT', 6_000, 601],
      ['TOUR', 4_000, 400],
    ]);
    expect(o.byCategory.reduce((a, c) => a + c.discountCents, 0)).toBe(o.discountCents);
    expect(o.byCategory.reduce((a, c) => a + c.netCents, 0)).toBe(o.netSalesCents);
  });

  it('merges repeated categories and keeps unit counts', () => {
    const o = deriveOrderAccounting(
      makeOrder({
        number: 'A-3',
        items: [item('BOAT', 5_000, 2), item('BOAT', 1_000, 1), item('TOUR', 3_000, 1)],
        payments: [payment('CASH', 14_000)],
      }),
    );
    expect(o.byCategory).toHaveLength(2);
    expect(o.byCategory[0]).toMatchObject({ category: 'BOAT', grossCents: 11_000, quantity: 3 });
  });

  it('puts a partial refund back across revenue, tax, fee and tip', () => {
    const o = deriveOrderAccounting(
      makeOrder({
        number: 'A-4',
        items: [item('BOAT', 9_000)],
        taxCents: 900,
        tipCents: 100,
        payments: [payment('CARD', 10_000, 5_000)],
      }),
    );
    expect(o.refundSplit).toMatchObject({
      revenueCents: 4_500,
      taxCents: 450,
      feeCents: 0,
      tipCents: 50,
      otherCents: 0,
      totalCents: 5_000,
    });
    // The split must be exhaustive — a refund cannot leak cents.
    const { revenueCents, taxCents, feeCents, tipCents, otherCents } = o.refundSplit;
    expect(revenueCents + taxCents + feeCents + tipCents + otherCents).toBe(5_000);
    expect(o.collectedNetCents).toBe(5_000);
  });

  it('charges a full refund entirely back out', () => {
    const o = deriveOrderAccounting(
      makeOrder({
        number: 'A-5',
        items: [item('TOUR', 12_000)],
        taxCents: 1_050,
        payments: [payment('CARD', 13_050, 13_050)],
      }),
    );
    expect(o.refundSplit.totalCents).toBe(13_050);
    expect(o.collectedNetCents).toBe(0);
    expect(o.receivableCents).toBe(0);
  });

  it('handles a comped order: revenue recognized, nothing collected in cash', () => {
    const o = deriveOrderAccounting(
      makeOrder({
        number: 'A-6',
        items: [item('CLASS', 7_500)],
        payments: [payment('COMP', 7_500)],
      }),
    );
    expect(o.grossCents).toBe(7_500);
    expect(o.byMethod.find((m) => m.method === 'COMP')!.netCents).toBe(7_500);
    expect(o.byMethod.find((m) => m.method === 'CARD')!.netCents).toBe(0);
    expect(o.issues).toEqual([]);
  });

  it('handles a fully promo-discounted order that collects nothing', () => {
    const o = deriveOrderAccounting(
      makeOrder({ number: 'A-7', items: [item('EVENT', 5_000)], discountCents: 5_000 }),
    );
    expect(o.netSalesCents).toBe(0);
    expect(o.totalCents).toBe(0);
    expect(o.receivableCents).toBe(0);
    expect(o.byCategory[0]).toMatchObject({ grossCents: 5_000, discountCents: 5_000, netCents: 0 });
    expect(o.issues).toEqual([]);
  });

  it('handles a zero-value order without dividing by zero', () => {
    const o = deriveOrderAccounting(makeOrder({ number: 'A-8', items: [item('OTHER', 0)] }));
    expect(o.totalCents).toBe(0);
    expect(o.byCategory).toEqual([
      { category: 'OTHER', grossCents: 0, discountCents: 0, netCents: 0, refundCents: 0, quantity: 1 },
    ]);
    expect(o.issues).toEqual([]);
  });

  it('treats an unexplained positive residual as a surcharge, not an error', () => {
    const o = deriveOrderAccounting(
      makeOrder({
        number: 'A-9',
        items: [item('BOAT', 10_000)],
        taxCents: 875,
        otherChargesCents: 500,
        payments: [payment('CARD', 11_375)],
      }),
    );
    expect(o.otherChargesCents).toBe(500);
    // Flat fees are inside the taxable base, so the surcharge is taxable sales.
    expect(o.taxableSalesCents).toBe(10_500);
    expect(o.issues).toEqual([]);
  });

  it('reports a total that is smaller than the sum of its parts', () => {
    const bad = makeOrder({ number: 'A-10', items: [item('BOAT', 10_000)], taxCents: 875 });
    const o = deriveOrderAccounting({ ...bad, totalCents: 10_000, balanceDueCents: 10_000 });
    expect(o.otherChargesCents).toBe(-875);
    expect(o.issues.map((i) => i.code)).toContain('COMPOSITION_RESIDUAL');
    expect(o.issues.find((i) => i.code === 'COMPOSITION_RESIDUAL')!.severity).toBe('error');
  });

  it('reports refunds larger than what was captured', () => {
    const o = deriveOrderAccounting(
      makeOrder({
        number: 'A-11',
        items: [item('BOAT', 5_000)],
        payments: [payment('CARD', 5_000, 6_000, 'PARTIAL_REFUND')],
      }),
    );
    expect(o.issues.map((i) => i.code)).toContain('OVER_REFUNDED');
  });

  it('reports a stored amount_paid that disagrees with the payment rows', () => {
    const o = deriveOrderAccounting(
      makeOrder({
        number: 'A-12',
        items: [item('BOAT', 5_000)],
        payments: [payment('CARD', 5_000)],
        overrides: { amountPaidCents: 4_000, balanceDueCents: 1_000 },
      }),
    );
    expect(o.issues.map((i) => i.code).sort()).toEqual(['BALANCE_MISMATCH', 'PAID_MISMATCH']);
    // The derivation wins; the stored value only produces the warning.
    expect(o.capturedCents).toBe(5_000);
    expect(o.receivableCents).toBe(0);
  });

  it('ignores uncaptured payments: failed, 3DS-pending, and pre-auth holds', () => {
    const o = deriveOrderAccounting(
      makeOrder({
        number: 'A-13',
        items: [item('BOAT', 10_000)],
        payments: [
          payment('CARD', 10_000, 0, 'FAILED'),
          payment('CARD', 10_000, 0, 'REQUIRES_ACTION'),
          payment('CARD', 10_000, 0, 'PRE_AUTHORIZED'),
          payment('CARD', 10_000, 0, 'PAID'),
        ],
      }),
    );
    expect(o.capturedCents).toBe(10_000);
    expect(o.receivableCents).toBe(0);
  });

  it('counts a disputed charge as captured — the chargeback rides on refunded_cents', () => {
    expect(isCapturedPayment('DISPUTED')).toBe(true);
    const o = deriveOrderAccounting(
      makeOrder({
        number: 'A-14',
        items: [item('BOAT', 10_000)],
        payments: [payment('CARD', 10_000, 10_000, 'DISPUTED')],
      }),
    );
    expect(o.capturedCents).toBe(10_000);
    expect(o.collectedNetCents).toBe(0);
  });

  it('scales categories to the stored subtotal when the item lines drift', () => {
    const drifted = makeOrder({ number: 'A-15', items: [item('BOAT', 6_000), item('TOUR', 4_000)] });
    const o = deriveOrderAccounting({
      ...drifted,
      subtotalCents: 5_000,
      totalCents: 5_000,
      balanceDueCents: 5_000,
    });
    expect(o.byCategory.reduce((a, c) => a + c.grossCents, 0)).toBe(5_000);
    expect(o.byCategory.map((c) => c.grossCents)).toEqual([3_000, 2_000]);
  });

  it('refuses fractional money at the boundary', () => {
    const o = makeOrder({ number: 'A-16', items: [item('BOAT', 100)] });
    expect(() => deriveOrderAccounting({ ...o, taxCents: 8.75 })).toThrow(AccountingError);
  });
});

// ---------------------------------------------------------------------------
// The export: journal, reconciliation, tax
// ---------------------------------------------------------------------------

describe('buildAccountingExport — the journal balances', () => {
  it('balances a single clean sale', () => {
    const r = build([
      makeOrder({
        number: 'B-1',
        items: [item('BOAT', 20_000)],
        taxCents: 1_750,
        processingFeeCents: 653,
        tipCents: 2_000,
        payments: [payment('CARD', 24_403)],
      }),
    ]);
    expect(r.journal.balanced).toBe(true);
    expect(r.journal.debitsCents).toBe(r.journal.creditsCents);
    expect(r.reconciliation.balanced).toBe(true);
    expect(r.reconciliation.varianceCents).toBe(0);
    expect(r.issues).toEqual([]);
  });

  it('balances a messy day: refunds, deposits, comps, gift cards, cash and promos', () => {
    const r = build(
      [
        makeOrder({
          number: 'B-2',
          items: [item('BOAT', 18_000), item('EQUIPMENT', 2_500)],
          discountCents: 2_050,
          taxCents: 1_616,
          processingFeeCents: 601,
          tipCents: 3_000,
          payments: [payment('CARD', 23_667, 5_000)],
        }),
        makeOrder({
          number: 'B-3',
          items: [item('TOUR', 9_900, 3)],
          taxCents: 2_599,
          // Deposit only — the rest is a receivable.
          payments: [payment('CARD', 10_000)],
        }),
        makeOrder({
          number: 'B-4',
          items: [item('CLASS', 7_500)],
          payments: [payment('COMP', 7_500)],
        }),
        makeOrder({
          number: 'B-5',
          items: [item('PATIO', 12_000)],
          taxCents: 1_050,
          payments: [payment('GIFT_CARD', 5_000), payment('CASH', 8_050)],
        }),
        makeOrder({ number: 'B-6', items: [item('EVENT', 5_000)], discountCents: 5_000 }),
        makeOrder({ number: 'B-7', items: [item('OTHER', 0)] }),
      ],
      {
        giftIssues: [
          { id: 'g1', code: 'GC-AAAA', kind: 'GIFT_CARD', issuedAt: NOON, faceValueCents: 25_000, method: 'CARD' },
        ] satisfies GiftIssueRow[],
        giftForfeits: [
          { id: 'g2', code: 'GC-BBBB', kind: 'GIFT_CERTIFICATE', forfeitedAt: NOON, amountCents: 3_000 },
        ],
        openingGiftLiabilityCents: 100_000,
      },
    );

    expect(r.journal.balanced).toBe(true);
    expect(r.journal.debitsCents).toBe(r.journal.creditsCents);
    expect(r.reconciliation.varianceCents).toBe(0);
    expect(r.reconciliation.balanced).toBe(true);
    expect(r.journal.lines.some((l) => l.accountName === 'Suspense — Unreconciled')).toBe(false);
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('proves the stated identity: gross − discounts + tax + fees + tips − refunds = collected', () => {
    const r = build([
      makeOrder({
        number: 'B-8',
        items: [item('BOAT', 30_000)],
        discountCents: 3_000,
        taxCents: 2_363,
        processingFeeCents: 879,
        tipCents: 4_000,
        payments: [payment('CARD', 34_242, 1_242)],
      }),
    ]);
    const rec = r.reconciliation;
    const identity =
      rec.grossSalesCents -
      rec.discountsCents +
      rec.otherChargesCents +
      rec.taxCents +
      rec.processingFeesCents +
      rec.tipsCents -
      rec.refundsCents -
      rec.receivableCents;
    expect(identity).toBe(rec.expectedCollectedCents);
    expect(rec.expectedCollectedCents).toBe(rec.collectedCents);
    expect(rec.varianceCents).toBe(0);
  });

  it('carries an unpaid balance as a receivable instead of pretending it was collected', () => {
    const r = build([
      makeOrder({
        number: 'B-9',
        items: [item('TOUR', 20_000)],
        payments: [payment('CARD', 5_000)],
      }),
    ]);
    expect(r.reconciliation.receivableCents).toBe(15_000);
    expect(r.reconciliation.collectedCents).toBe(5_000);
    expect(r.reconciliation.varianceCents).toBe(0);
    const ar = r.journal.lines.find((l) => l.role === 'ACCOUNTS_RECEIVABLE');
    expect(ar).toMatchObject({ debitCents: 15_000, creditCents: 0 });
  });

  it('posts tips to a liability account, never to revenue', () => {
    const r = build([
      makeOrder({ number: 'B-10', items: [item('BOAT', 10_000)], tipCents: 2_000, payments: [payment('CARD', 12_000)] }),
    ]);
    const tips = r.journal.lines.find((l) => l.role === 'TIPS_PAYABLE')!;
    expect(tips).toMatchObject({ accountCode: '2300', creditCents: 2_000, debitCents: 0 });
    const revenue = r.journal.lines.filter((l) => l.role === 'REVENUE');
    expect(revenue.reduce((a, l) => a + l.creditCents, 0)).toBe(10_000);
  });

  it('releases the tax and tip share of a refund instead of charging it all to revenue', () => {
    const r = build([
      makeOrder({
        number: 'B-11',
        items: [item('BOAT', 9_000)],
        taxCents: 900,
        tipCents: 100,
        payments: [payment('CARD', 10_000, 5_000)],
      }),
    ]);
    expect(r.journal.lines.find((l) => l.role === 'SALES_TAX_PAYABLE')!.creditCents).toBe(450);
    expect(r.journal.lines.find((l) => l.role === 'TIPS_PAYABLE')!.creditCents).toBe(50);
    expect(r.journal.lines.find((l) => l.role === 'REFUNDS')!.debitCents).toBe(4_500);
  });

  it('debits gift-card liability on redemption and credits it on issue', () => {
    const r = build(
      [
        makeOrder({
          number: 'B-12',
          items: [item('PATIO', 6_000)],
          payments: [payment('GIFT_CARD', 6_000)],
        }),
      ],
      {
        giftIssues: [
          { id: 'g', code: 'GC-CCCC', kind: 'GIFT_CARD', issuedAt: NOON, faceValueCents: 10_000, method: 'CASH' },
        ],
        openingGiftLiabilityCents: 50_000,
      },
    );
    const liability = r.journal.lines.filter((l) => l.role === 'GIFT_LIABILITY');
    expect(liability.reduce((a, l) => a + l.debitCents, 0)).toBe(6_000);
    expect(liability.reduce((a, l) => a + l.creditCents, 0)).toBe(10_000);
    expect(r.gift).toMatchObject({
      issuedCents: 10_000,
      redeemedCents: 6_000,
      netLiabilityChangeCents: 4_000,
      closingLiabilityCents: 54_000,
    });
    // A redemption is not a bank deposit; the cash taken for the card sold is,
    // but it belongs to no order so it gets its own line.
    expect(r.reconciliation.cashCollectedCents).toBe(0);
    expect(r.reconciliation.giftCardSoldCents).toBe(10_000);
    expect(r.journal.balanced).toBe(true);
  });

  it('releases expired gift-card liability to breakage income', () => {
    const r = build([], {
      giftForfeits: [{ id: 'g', code: 'GC-DDDD', kind: 'GIFT_CARD', forfeitedAt: NOON, amountCents: 2_500 }],
      openingGiftLiabilityCents: 10_000,
    });
    expect(r.journal.lines.find((l) => l.role === 'GIFT_BREAKAGE')!.creditCents).toBe(2_500);
    expect(r.journal.lines.find((l) => l.role === 'GIFT_LIABILITY')!.debitCents).toBe(2_500);
    expect(r.gift.closingLiabilityCents).toBe(7_500);
    expect(r.journal.balanced).toBe(true);
  });

  it('keeps comps off the cash line and on a visible contra-revenue account', () => {
    const r = build([
      makeOrder({ number: 'B-13', items: [item('CLASS', 7_500)], payments: [payment('COMP', 7_500)] }),
    ]);
    expect(r.reconciliation.cashCollectedCents).toBe(0);
    expect(r.reconciliation.compedCents).toBe(7_500);
    expect(r.journal.lines.find((l) => l.role === 'COMPS')).toMatchObject({
      accountCode: '4960',
      debitCents: 7_500,
    });
  });

  it('produces an empty, trivially balanced journal for a day with no activity', () => {
    const r = build([]);
    expect(r.journal.lines).toEqual([]);
    expect(r.journal.balanced).toBe(true);
    expect(r.reconciliation.balanced).toBe(true);
    expect(r.reconciliation.orderCount).toBe(0);
  });

  it('plugs an unbalanced journal to a visibly-named Suspense account and shouts', () => {
    // A negative composition residual is the one input that can unbalance the
    // journal: the order total contradicts its own components.
    const bad = makeOrder({ number: 'B-14', items: [item('BOAT', 10_000)], taxCents: 875 });
    const r = build([{ ...bad, totalCents: 10_000, balanceDueCents: 10_000 }]);
    const suspense = r.journal.lines.find((l) => l.role === 'SUSPENSE');
    expect(suspense).toBeDefined();
    expect(suspense!.accountName).toBe('Suspense — Unreconciled');
    expect(r.journal.debitsCents).toBe(r.journal.creditsCents);
    expect(r.reconciliation.balanced).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('JOURNAL_OUT_OF_BALANCE');
  });

  it('reports money that settled in the window against another period, without hiding it', () => {
    const r = build(
      [makeOrder({ number: 'B-15', items: [item('BOAT', 10_000)], payments: [payment('CARD', 10_000)] })],
      {
        settlements: [
          { paymentId: 'p1', method: 'CARD', status: 'PAID', amountCents: 10_000, refundedCents: 0, processedAt: NOON },
          // Yesterday's order, paid today.
          { paymentId: 'p2', method: 'CASH', status: 'PAID', amountCents: 4_500, refundedCents: 0, processedAt: NOON },
        ],
      },
    );
    expect(r.reconciliation.settlementCents).toBe(14_500);
    expect(r.reconciliation.settlementVarianceCents).toBe(4_500);
    expect(r.issues.map((i) => i.code)).toContain('SETTLEMENT_VARIANCE');
    // A timing difference is a warning, not a broken export.
    expect(r.issues.find((i) => i.code === 'SETTLEMENT_VARIANCE')!.severity).toBe('warning');
    expect(r.journal.balanced).toBe(true);
  });

  it('rolls revenue up by activity category across orders', () => {
    const r = build([
      makeOrder({ number: 'B-16', items: [item('BOAT', 10_000)], payments: [payment('CASH', 10_000)] }),
      makeOrder({
        number: 'B-17',
        items: [item('BOAT', 5_000), item('TOUR', 8_000)],
        payments: [payment('CASH', 13_000)],
      }),
    ]);
    expect(r.revenueByCategory.map((c) => [c.category, c.grossCents])).toEqual([
      ['BOAT', 15_000],
      ['TOUR', 8_000],
    ]);
    const revenueLines = r.journal.lines.filter((l) => l.role === 'REVENUE');
    expect(revenueLines.map((l) => l.accountCode).sort()).toEqual(['4010', '4050']);
    expect(revenueLines.every((l) => l.className)).toBe(true);
  });

  it('routes revenue through the operator chart when one is supplied', () => {
    const r = build([makeOrder({ number: 'B-18', items: [item('BOAT', 1_000)], payments: [payment('CASH', 1_000)] })], {
      accounts: [{ code: '4001', name: 'Charter Income', category: 'REVENUE:BOAT' }],
    });
    expect(r.journal.lines.find((l) => l.role === 'REVENUE')).toMatchObject({
      accountCode: '4001',
      accountName: 'Charter Income',
    });
  });
});

// ---------------------------------------------------------------------------
// Tax remittance
// ---------------------------------------------------------------------------

describe('tax remittance report', () => {
  it('separates taxable from exempt sales and nets refunded tax out of tax due', () => {
    const r = build(
      [
        makeOrder({
          number: 'C-1',
          items: [item('BOAT', 10_000)],
          taxCents: 875,
          payments: [payment('CARD', 10_875)],
        }),
        makeOrder({
          number: 'C-2',
          items: [item('BOAT', 4_000)],
          taxCents: 350,
          payments: [payment('CARD', 4_350, 2_175)],
        }),
        // Tax-exempt (a non-profit charter): no tax line at all.
        makeOrder({ number: 'C-3', items: [item('TOUR', 6_000)], payments: [payment('CASH', 6_000)] }),
      ],
      { taxGranularity: 'period' },
    );
    const t = r.tax.totals;
    expect(t.taxableSalesCents).toBe(14_000);
    expect(t.exemptSalesCents).toBe(6_000);
    expect(t.taxCollectedCents).toBe(1_225);
    expect(t.taxRefundedCents).toBe(175);
    expect(t.taxDueCents).toBe(1_050);
    expect(t.effectiveRatePercent).toBeCloseTo(7.5, 4);
  });

  it('excludes tips and processing fees from the taxable base', () => {
    const r = build(
      [
        makeOrder({
          number: 'C-4',
          items: [item('BOAT', 10_000)],
          taxCents: 875,
          processingFeeCents: 326,
          tipCents: 5_000,
          payments: [payment('CARD', 16_201)],
        }),
      ],
      { taxGranularity: 'period' },
    );
    expect(r.tax.totals.taxableSalesCents).toBe(10_000);
  });

  it('taxes the base net of discount, matching how pricing computes it', () => {
    const r = build(
      [
        makeOrder({
          number: 'C-5',
          items: [item('BOAT', 10_000)],
          discountCents: 2_000,
          taxCents: 700,
          payments: [payment('CARD', 8_700)],
        }),
      ],
      { taxGranularity: 'period' },
    );
    expect(r.tax.totals.taxableSalesCents).toBe(8_000);
    expect(r.tax.totals.effectiveRatePercent).toBeCloseTo(8.75, 4);
  });

  it('groups by the operator local day, not UTC', () => {
    const r = buildAccountingExport({
      periodStart: new Date('2026-06-15T07:00:00.000Z'),
      periodEnd: new Date('2026-06-17T07:00:00.000Z'),
      timeZone: TZ,
      operatorName: 'Lake Sonoma Marina',
      taxGranularity: 'day',
      orders: [
        makeOrder({
          number: 'C-6',
          items: [item('BOAT', 1_000)],
          taxCents: 88,
          createdAt: new Date('2026-06-16T05:30:00.000Z'), // 22:30 on the 15th, Pacific
          payments: [payment('CARD', 1_088)],
        }),
        makeOrder({
          number: 'C-7',
          items: [item('BOAT', 1_000)],
          taxCents: 88,
          createdAt: new Date('2026-06-16T18:00:00.000Z'),
          payments: [payment('CARD', 1_088)],
        }),
      ],
    });
    expect(r.tax.rows.map((row) => row.periodKey)).toEqual(['2026-06-15', '2026-06-16']);
    expect(r.tax.rows.every((row) => row.taxDueCents === 88)).toBe(true);
  });

  it('leaves the effective rate null rather than dividing by zero', () => {
    const r = build([makeOrder({ number: 'C-8', items: [item('TOUR', 5_000)], payments: [payment('CASH', 5_000)] })], {
      taxGranularity: 'period',
    });
    expect(r.tax.totals.effectiveRatePercent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// File shapes
// ---------------------------------------------------------------------------

describe('serialization', () => {
  const result = build([
    makeOrder({
      number: 'D-1',
      items: [item('BOAT', 20_000)],
      taxCents: 1_750,
      tipCents: 2_000,
      payments: [payment('CARD', 23_750)],
    }),
  ]);

  it('writes a QuickBooks Online journal CSV keyed on account name', () => {
    const csv = toQuickBooksJournalCsv(result.journal, { timeZone: TZ });
    const [header, ...rows] = csv.split('\r\n');
    expect(header.startsWith('*JournalNo,*JournalDate,*Currency,Memo,*AccountName,Debits,Credits')).toBe(true);
    expect(rows).toHaveLength(result.journal.lines.length);
    expect(rows.every((r) => r.includes('06/15/2026'))).toBe(true);
    // Every line carries exactly one of debit / credit.
    for (const line of result.journal.lines) {
      expect(line.debitCents === 0 || line.creditCents === 0).toBe(true);
    }
    expect(csv).toContain('Undeposited Funds');
    expect(csv).toContain('237.50');
  });

  it('writes an IIF general journal with signed amounts and a trailing newline', () => {
    const iif = toQuickBooksIif(result.journal, { timeZone: TZ });
    const lines = iif.split('\r\n');
    expect(lines[0].startsWith('!TRNS\t')).toBe(true);
    expect(lines[1].startsWith('!SPL\t')).toBe(true);
    expect(lines[2]).toBe('!ENDTRNS');
    expect(lines[3].startsWith('TRNS\tGENERAL JOURNAL\t06/15/2026\t')).toBe(true);
    expect(lines.filter((l) => l.startsWith('SPL\t'))).toHaveLength(result.journal.lines.length - 1);
    expect(lines.some((l) => l === 'ENDTRNS')).toBe(true);
    expect(iif.endsWith('\r\n')).toBe(true);
    // Signed dollars must net to zero across the transaction.
    const amounts = lines
      .filter((l) => l.startsWith('TRNS\t') || l.startsWith('SPL\t'))
      .map((l) => Math.round(Number(l.split('\t')[6]) * 100));
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('writes a Xero manual journal keyed on account code with a single signed amount', () => {
    const csv = toXeroManualJournalCsv(result.journal, { timeZone: TZ });
    const [header, ...rows] = csv.split('\r\n');
    expect(header).toBe(
      '*Narration,*Date,Description,*AccountCode,*TaxRate,*Amount,TrackingName1,TrackingOption1',
    );
    expect(rows.every((r) => r.includes('2026-06-15'))).toBe(true);
    expect(rows.every((r) => r.includes('No Tax'))).toBe(true);
    const amounts = rows.map((r) => {
      // Narration and description may be quoted; the amount is the 6th field and
      // never contains a comma, so a naive split is safe after unquoting.
      const cells = r.match(/("([^"]|"")*"|[^,]*)/g)!.filter((_, i) => i % 2 === 0);
      return Math.round(Number(cells[5]) * 100);
    });
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('renders the reconciliation as a readable statement ending in the variance', () => {
    const csv = serializeExport(result, 'reconciliation-csv');
    expect(csv).toContain('Gross sales,200.00');
    expect(csv).toContain('Plus tips (liability),20.00');
    expect(csv).toContain('Variance,0.00');
    expect(csv).toContain('Balanced,YES');
  });

  it('renders every supported format without throwing', () => {
    for (const format of [
      'quickbooks-csv',
      'quickbooks-iif',
      'xero-csv',
      'tax-csv',
      'reconciliation-csv',
      'detail-csv',
      'revenue-csv',
      'gift-csv',
      'issues-csv',
    ] as const) {
      expect(typeof serializeExport(result, format)).toBe('string');
    }
  });

  it('names files by format and period', () => {
    expect(exportFilename('quickbooks-iif', '2026-06-01', '2026-06-30')).toBe(
      'marina_quickbooks_2026-06-01_2026-06-30.iif',
    );
    expect(exportFilename('xero-csv', '2026-06-01', '2026-06-30')).toBe(
      'marina_xero_2026-06-01_2026-06-30.csv',
    );
  });
});
