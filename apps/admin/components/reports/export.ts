/**
 * Report → CSV row builders.
 *
 * These take the already-loaded report objects and shape them into header + rows
 * for `toCsv`. Kept free of `server-only` and of any DB access so the SAME
 * builders run on the server (the `exportReportCsv` action) and in the browser
 * (the instant-download `ExportButton`). One serialization, two delivery paths.
 *
 * All money columns are emitted as plain dollar decimals (e.g. 1234 cents ->
 * "12.34") — the natural unit for a spreadsheet — while the app keeps integer
 * cents everywhere internally.
 */
import { fromCents, PAYMENT_METHOD_LABEL, type PaymentMethodKey } from '@marina/core';
import { toCsv, type CsvRow } from './csv';
import { type ReportKind, REPORT_LABEL } from './kinds';
import type {
  EndOfDayReport,
  GiftCardReport,
  HeadCountReport,
  MerchandiseReport,
  OccupancyReport,
  RevenueReport,
  SalesReport,
  TaxesFeesReport,
} from './queries';

export { REPORT_LABEL, type ReportKind };

/** Dollars with 2 decimals, no thousands separators (CSV-friendly). */
function dollars(cents: number): string {
  return fromCents(cents).toFixed(2);
}

/** Percent from a 0–1 ratio, one decimal (e.g. 0.732 -> "73.2"). */
function pct(ratio: number): string {
  return (ratio * 100).toFixed(1);
}

function revenueCsv(report: RevenueReport): string {
  const header = ['Date', 'Orders', 'Gross Revenue (USD)'] as const;
  const rows: CsvRow[] = report.daily.map((d) => [d.date, d.orders, dollars(d.grossCents)]);

  // Totals + a per-activity breakdown appended as labeled sections.
  rows.push([]);
  rows.push(['Totals', report.totals.orders, dollars(report.totals.grossCents)]);
  rows.push(['Subtotal (USD)', '', dollars(report.totals.subtotalCents)]);
  rows.push(['Discounts (USD)', '', dollars(report.totals.discountCents)]);
  rows.push(['Tax (USD)', '', dollars(report.totals.taxCents)]);
  rows.push(['Processing Fees (USD)', '', dollars(report.totals.processingFeeCents)]);
  rows.push(['Tips (USD)', '', dollars(report.totals.tipCents)]);
  rows.push(['Net Sales (USD)', '', dollars(report.totals.netSalesCents)]);
  rows.push(['Avg Order Value (USD)', '', dollars(report.totals.avgOrderValueCents)]);

  rows.push([]);
  rows.push(['Activity', 'Bookings', 'Seats', 'Gross Revenue (USD)']);
  for (const a of report.byActivity) {
    rows.push([a.activityName, a.bookings, a.seats, dollars(a.grossCents)]);
  }

  return toCsv(header, rows);
}

function taxesFeesCsv(report: TaxesFeesReport): string {
  const header = ['Date', 'Tax Collected (USD)', 'Processing Fees (USD)'] as const;
  const rows: CsvRow[] = report.daily.map((d) => [
    d.date,
    dollars(d.taxCents),
    dollars(d.processingFeeCents),
  ]);

  rows.push([]);
  rows.push(['Totals', dollars(report.totals.taxCents), dollars(report.totals.processingFeeCents)]);
  rows.push(['Taxable Base (USD)', dollars(report.totals.taxableBaseCents), '']);
  rows.push(['Discounts (USD)', dollars(report.totals.discountCents), '']);
  rows.push(['Tips (USD)', dollars(report.totals.tipCents), '']);
  rows.push(['Orders', report.totals.orders, '']);

  rows.push([]);
  rows.push(['Configured Fee', 'Type', 'Value', 'Scope', 'Enabled']);
  for (const f of report.configuredFees) {
    const value = f.type === 'PERCENT' ? `${f.value}%` : dollars(Math.round(f.value));
    rows.push([f.name, f.type, value, f.scope, f.enabled ? 'Yes' : 'No']);
  }

  return toCsv(header, rows);
}

function occupancyCsv(report: OccupancyReport): string {
  const header = ['Date', 'Seats Booked', 'Seats Total', 'Occupancy (%)'] as const;
  const rows: CsvRow[] = report.daily.map((d) => [
    d.date,
    d.capacityBooked,
    d.capacityTotal,
    pct(d.ratio),
  ]);

  rows.push([]);
  rows.push([
    'Totals',
    report.totals.capacityBooked,
    report.totals.capacityTotal,
    pct(report.totals.ratio),
  ]);
  rows.push(['Timeslots', report.totals.slots, '', '']);

  rows.push([]);
  rows.push(['Activity', 'Seats Booked', 'Seats Total', 'Occupancy (%)', 'Timeslots']);
  for (const a of report.byActivity) {
    rows.push([a.activityName, a.capacityBooked, a.capacityTotal, pct(a.ratio), a.slots]);
  }

  return toCsv(header, rows);
}

function salesCsv(report: SalesReport): string {
  // Full-detail export: every allocated sale line is the primary body, followed
  // by the aggregated items, payments-by-method, summary totals, reconciliation
  // proof, and (when on) the comparison — the whole report, not just headlines.
  const header = [
    'Date',
    'Order',
    'Group',
    'Item',
    'Detail',
    'Qty',
    'Unit Price (USD)',
    'Gross (USD)',
    'Discounts (USD)',
    'Net (USD)',
    'Taxes & Fees (USD)',
    'Total (USD)',
  ] as const;
  const rows: CsvRow[] = report.details.map((l) => [
    l.date,
    l.orderNumber,
    l.group,
    l.label,
    l.sublabel ?? '',
    l.quantity,
    l.unitPriceCents === null ? '' : dollars(l.unitPriceCents),
    dollars(l.grossCents),
    dollars(l.discountCents),
    dollars(l.netCents),
    dollars(l.taxCents),
    dollars(l.totalCents),
  ]);

  rows.push([]);
  rows.push(['Itemized (aggregated)']);
  rows.push(['Group', 'Item', 'Detail', 'Qty', '', 'Gross (USD)', 'Discounts (USD)', 'Net (USD)', 'Taxes & Fees (USD)', 'Total (USD)']);
  for (const group of report.itemized.groups) {
    for (const r of group.rows) {
      rows.push([
        group.label,
        r.label,
        r.sublabel ?? '',
        r.quantity,
        '',
        dollars(r.grossCents),
        dollars(r.discountCents),
        dollars(r.netCents),
        dollars(r.taxCents),
        dollars(r.totalCents),
      ]);
    }
    rows.push([
      `${group.label} total`,
      '',
      '',
      group.totals.quantity,
      '',
      dollars(group.totals.grossCents),
      dollars(group.totals.discountCents),
      dollars(group.totals.netCents),
      dollars(group.totals.taxCents),
      dollars(group.totals.totalCents),
    ]);
  }
  rows.push(['Tips', '', '', '', '', '', '', '', '', dollars(report.itemized.tipCents)]);
  rows.push([
    'Grand total',
    '',
    '',
    report.itemized.totals.quantity,
    '',
    dollars(report.itemized.totals.grossCents),
    dollars(report.itemized.totals.discountCents),
    dollars(report.itemized.totals.netCents),
    dollars(report.itemized.totals.taxCents),
    dollars(report.itemized.grandTotalCents),
  ]);

  rows.push([]);
  rows.push(['Payments by method', 'Collected (USD)', 'Refunded (USD)', 'Net (USD)', 'Count']);
  for (const m of report.payments.byMethod) {
    rows.push([
      PAYMENT_METHOD_LABEL[m.method as PaymentMethodKey] ?? m.method,
      dollars(m.collectedCents),
      dollars(m.refundedCents),
      dollars(m.netCents),
      m.count,
    ]);
  }
  rows.push([
    'All methods',
    dollars(report.payments.totals.collectedCents),
    dollars(report.payments.totals.refundedCents),
    dollars(report.payments.totals.netCents),
    report.payments.totals.count,
  ]);

  rows.push([]);
  rows.push([`Sales totals (basis: ${report.basis === 'appointment' ? 'appointment date' : 'order date'})`]);
  rows.push(['Activities (USD)', dollars(report.activitiesCents)]);
  rows.push(['Packages (USD)', dollars(report.packagesCents)]);
  rows.push(['Merchandise (USD)', dollars(report.merchandiseCents)]);
  rows.push(['Subtotal (USD)', dollars(report.totals.subtotalCents)]);
  rows.push(['Discounts (USD)', dollars(report.totals.discountCents)]);
  rows.push(['Net Sales (USD)', dollars(report.totals.netSalesCents)]);
  rows.push(['Taxes & Fees (USD)', dollars(report.totals.taxesAndFeesCents)]);
  rows.push(['  Tax (USD)', dollars(report.totals.taxCents)]);
  rows.push(['  Processing Fees (USD)', dollars(report.totals.processingFeeCents)]);
  rows.push(['Tips (USD)', dollars(report.totals.tipCents)]);
  rows.push(['Charges (USD)', dollars(report.chargesCents)]);
  rows.push(['Gross Sales (USD)', dollars(report.totals.grossSalesCents)]);
  rows.push(['Orders', report.totals.orders]);

  rows.push([]);
  rows.push(['Reconciliation', report.itemized.reconciliation.ok ? 'RECONCILED' : 'DISCREPANCY']);
  for (const c of report.itemized.reconciliation.checks) {
    rows.push([c.name, dollars(c.expectedCents), dollars(c.actualCents), c.ok ? 'ok' : `off by ${dollars(c.diffCents)}`]);
  }

  if (report.comparison) {
    const c = report.comparison;
    rows.push([]);
    rows.push([`Comparison vs ${c.range.from} – ${c.range.to}`, 'Current', 'Previous', 'Change']);
    const line = (label: string, cur: number, prev: number) =>
      rows.push([label, dollars(cur), dollars(prev), dollars(cur - prev)]);
    line('Gross Sales (USD)', report.totals.grossSalesCents, c.totals.grossSalesCents);
    line('Taxes & Fees (USD)', report.totals.taxesAndFeesCents, c.totals.taxesAndFeesCents);
    line('Tips (USD)', report.totals.tipCents, c.totals.tipCents);
    line('Net Sales (USD)', report.totals.netSalesCents, c.totals.netSalesCents);
    rows.push(['Orders', report.totals.orders, c.totals.orders, report.totals.orders - c.totals.orders]);
  }

  return toCsv(header, rows);
}

function merchandiseCsv(report: MerchandiseReport): string {
  const header = [
    'Category',
    'Product',
    'Variant',
    'Cost/Unit (USD)',
    'Qty Sold',
    'Gross (USD)',
    'Discount (USD)',
    'Total Sales (USD)',
  ] as const;
  const rows: CsvRow[] = [];

  for (const cat of report.data.categories) {
    for (const p of cat.products) {
      for (const v of p.variants) {
        rows.push([
          cat.category,
          p.name,
          v.variant ?? '',
          v.unitPriceCents === null ? '' : dollars(v.unitPriceCents),
          v.quantity,
          dollars(v.grossCents),
          dollars(v.discountCents),
          dollars(v.totalCents),
        ]);
      }
      if (p.hasVariants) {
        rows.push([
          cat.category,
          `${p.name} (total)`,
          '',
          p.unitPriceCents === null ? '' : dollars(p.unitPriceCents),
          p.quantity,
          dollars(p.grossCents),
          dollars(p.discountCents),
          dollars(p.totalCents),
        ]);
      }
    }
    rows.push([
      `${cat.category} subtotal`,
      '',
      '',
      '',
      cat.totals.quantity,
      dollars(cat.totals.grossCents),
      dollars(cat.totals.discountCents),
      dollars(cat.totals.totalCents),
    ]);
  }

  rows.push([]);
  rows.push([
    'Grand total',
    '',
    '',
    '',
    report.data.totals.quantity,
    dollars(report.data.totals.grossCents),
    dollars(report.data.totals.discountCents),
    dollars(report.data.totals.totalCents),
  ]);
  rows.push(['Orders with merchandise', '', '', '', report.data.orders, '', '', '']);

  if (report.comparison) {
    const c = report.comparison;
    rows.push([]);
    rows.push([`Comparison vs ${c.range.from} – ${c.range.to}`, 'Current', 'Previous', 'Change']);
    rows.push([
      'Total Sales (USD)',
      dollars(report.data.totals.totalCents),
      dollars(c.totals.totalCents),
      dollars(report.data.totals.totalCents - c.totals.totalCents),
    ]);
    rows.push([
      'Qty Sold',
      report.data.totals.quantity,
      c.totals.quantity,
      report.data.totals.quantity - c.totals.quantity,
    ]);
  }

  return toCsv(header, rows);
}

function endOfDayCsv(report: EndOfDayReport): string {
  // The full register tape is the primary body (every tender, no UI row cap).
  const header = [
    'Processed At',
    'Order',
    'Method',
    'Manually Keyed',
    'Amount (USD)',
    'Refunded (USD)',
    'Net (USD)',
  ] as const;
  const rows: CsvRow[] = report.transactions.map((t) => [
    t.processedAt,
    t.orderNumber,
    PAYMENT_METHOD_LABEL[t.method as PaymentMethodKey] ?? t.method,
    t.manuallyKeyed ? 'Yes' : 'No',
    dollars(t.amountCents),
    dollars(t.refundedCents),
    dollars(t.netCents),
  ]);

  rows.push([]);
  rows.push(['Tenders by method', 'Count', '', '', 'Collected (USD)', 'Refunded (USD)', 'Net (USD)']);
  for (const m of report.payments.byMethod) {
    rows.push([
      PAYMENT_METHOD_LABEL[m.method as PaymentMethodKey] ?? m.method,
      m.count,
      '',
      '',
      dollars(m.collectedCents),
      dollars(m.refundedCents),
      dollars(m.netCents),
    ]);
  }
  rows.push([
    'All methods',
    report.payments.totals.count,
    '',
    '',
    dollars(report.payments.totals.collectedCents),
    dollars(report.payments.totals.refundedCents),
    dollars(report.payments.totals.netCents),
  ]);

  rows.push([]);
  rows.push(['Daily', 'Count', '', '', 'Collected (USD)', 'Refunded (USD)', 'Net (USD)']);
  for (const d of report.daily) {
    rows.push([d.date, d.count, '', '', dollars(d.collectedCents), dollars(d.refundedCents), dollars(d.netCents)]);
  }

  return toCsv(header, rows);
}

function headCountCsv(report: HeadCountReport): string {
  const header = ['Date', 'Guests', 'Bookings'] as const;
  const rows: CsvRow[] = report.daily.map((d) => [d.date, d.guests, d.bookings]);

  rows.push([]);
  rows.push(['Totals', report.totals.guests, report.totals.bookings]);
  rows.push(['Orders', report.totals.orders, '']);
  rows.push(['Avg Party Size', report.totals.avgPartySize.toFixed(1), '']);

  rows.push([]);
  rows.push(['Activity', 'Guests', 'Bookings', 'Avg Party Size']);
  for (const a of report.byActivity) {
    rows.push([a.activityName, a.guests, a.bookings, a.avgPartySize.toFixed(1)]);
  }

  return toCsv(header, rows);
}

function giftCardsCsv(report: GiftCardReport): string {
  const header = ['Metric', 'Count', 'Amount (USD)'] as const;
  const rows: CsvRow[] = [
    ['Outstanding liability', '', dollars(report.liabilityCents)],
    ['Issued (in range)', report.issued.count, dollars(report.issued.amountCents)],
    ['Redeemed (in range)', report.redeemed.count, dollars(report.redeemed.amountCents)],
  ];

  rows.push([]);
  rows.push(['Card Status', 'Count', 'Balance (USD)']);
  for (const s of report.byStatus) {
    rows.push([s.status, s.count, dollars(s.balanceCents)]);
  }

  return toCsv(header, rows);
}

/** Bundle slice needed to serialize any report kind. */
export interface ExportableReports {
  revenue: RevenueReport;
  sales: SalesReport;
  merchandise: MerchandiseReport;
  taxesFees: TaxesFeesReport;
  occupancy: OccupancyReport;
  giftCards: GiftCardReport;
  endOfDay: EndOfDayReport;
  headCount: HeadCountReport;
}

/** Serialize the requested report kind to a CSV string (no BOM; add at output). */
export function buildReportCsv(kind: ReportKind, reports: ExportableReports): string {
  switch (kind) {
    case 'sales':
      return salesCsv(reports.sales);
    case 'merchandise':
      return merchandiseCsv(reports.merchandise);
    case 'taxes-fees':
      return taxesFeesCsv(reports.taxesFees);
    case 'occupancy':
      return occupancyCsv(reports.occupancy);
    case 'gift-cards':
      return giftCardsCsv(reports.giftCards);
    case 'end-of-day':
      return endOfDayCsv(reports.endOfDay);
    case 'head-count':
      return headCountCsv(reports.headCount);
    case 'revenue':
    default:
      return revenueCsv(reports.revenue);
  }
}
