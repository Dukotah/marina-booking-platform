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
import { fromCents } from '@marina/core';
import { toCsv, type CsvRow } from './csv';
import { type ReportKind, REPORT_LABEL } from './kinds';
import type { OccupancyReport, RevenueReport, TaxesFeesReport } from './queries';
import type { LocationReport } from './ByLocationReportView';
import type { TransactionsReport } from './TransactionsReportView';

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

function byLocationCsv(report: LocationReport): string {
  const header = ['Location ID', 'Location', 'Bookings', 'Participants', 'Gross (USD)'] as const;
  const rows: CsvRow[] = report.byLocation.map((loc) => [
    loc.locationId,
    loc.locationName,
    loc.bookingCount,
    loc.totalQuantity,
    dollars(loc.grossCents),
  ]);

  rows.push([]);
  rows.push([
    '',
    'TOTAL (all locations)',
    report.total.bookingCount,
    report.total.totalQuantity,
    dollars(report.total.grossCents),
  ]);

  return toCsv(header, rows);
}

function transactionsCsv(report: TransactionsReport): string {
  // Transaction journal — one row per payment.
  const header = [
    'Date',
    'Order Number',
    'Customer',
    'Method',
    'Processor',
    'Processor Txn ID',
    'Status',
    'Gross (USD)',
    'Refunded (USD)',
    'Net (USD)',
    'Manually Keyed',
  ] as const;

  const rows: CsvRow[] = report.transactions.map((t) => [
    t.date,
    t.orderNumber,
    t.customerName,
    t.method,
    t.processor,
    t.processorTransactionId ?? '',
    t.status,
    dollars(t.grossCents),
    dollars(t.refundedCents),
    dollars(t.netCents),
    t.manuallyKeyed ? 'yes' : 'no',
  ]);

  // Per-tender reconciliation breakdown.
  rows.push([]);
  rows.push(['Tender', 'Count', 'Gross (USD)', 'Refunded (USD)', 'Net (USD)', '', '', '', '', '', '']);
  for (const m of report.byMethod) {
    rows.push([m.method, m.count, dollars(m.grossCents), dollars(m.refundedCents), dollars(m.netCents)]);
  }
  rows.push([]);
  rows.push([
    'TOTAL',
    report.count,
    dollars(report.totalGrossCents),
    dollars(report.totalRefundedCents),
    dollars(report.totalNetCents),
  ]);

  return toCsv(header, rows);
}

/** Bundle slice needed to serialize any of the five reports. */
export interface ExportableReports {
  revenue: RevenueReport;
  taxesFees: TaxesFeesReport;
  occupancy: OccupancyReport;
  byLocation?: LocationReport;
  transactions?: TransactionsReport;
}

/** Serialize the requested report kind to a CSV string (no BOM; add at output). */
export function buildReportCsv(kind: ReportKind, reports: ExportableReports): string {
  switch (kind) {
    case 'taxes-fees':
      return taxesFeesCsv(reports.taxesFees);
    case 'occupancy':
      return occupancyCsv(reports.occupancy);
    case 'by-location':
      if (!reports.byLocation) return toCsv(['Error'], [['No by-location data available']]);
      return byLocationCsv(reports.byLocation);
    case 'transactions':
      if (!reports.transactions) return toCsv(['Error'], [['No transactions data available']]);
      return transactionsCsv(reports.transactions);
    case 'revenue':
    default:
      return revenueCsv(reports.revenue);
  }
}
