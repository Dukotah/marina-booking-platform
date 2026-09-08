/**
 * Report-kind constants and helpers — client-safe (no `server-only`, no DB).
 *
 * Kept separate from `queries.ts` (which is `server-only`) so client components
 * like the tab strip and export button can import the kind list/labels without
 * pulling the server-only data layer into a browser bundle.
 */

export type ReportKind =
  | 'revenue'
  | 'sales'
  | 'merchandise'
  | 'taxes-fees'
  | 'occupancy'
  | 'gift-cards'
  | 'end-of-day'
  | 'head-count';

export const REPORT_KINDS: ReportKind[] = [
  'revenue',
  'sales',
  'merchandise',
  'taxes-fees',
  'occupancy',
  'gift-cards',
  'end-of-day',
  'head-count',
];

/** Human label for a report kind (tabs, filenames, headings). */
export const REPORT_LABEL: Record<ReportKind, string> = {
  revenue: 'Revenue',
  sales: 'Sales',
  merchandise: 'Merchandise',
  'taxes-fees': 'Taxes & Fees',
  occupancy: 'Occupancy',
  'gift-cards': 'Gift Cards',
  'end-of-day': 'End of Day',
  'head-count': 'Head Count',
};

/** Validate/normalize an arbitrary string into a known report kind (defaults to revenue). */
export function resolveReportKind(raw?: string): ReportKind {
  return (REPORT_KINDS as string[]).includes(raw ?? '') ? (raw as ReportKind) : 'revenue';
}

/** The sales-report sub-view: summary KPIs, aggregated items, or raw lines. */
export type SalesView = 'summary' | 'items' | 'details';

export const SALES_VIEWS: SalesView[] = ['summary', 'items', 'details'];

export const SALES_VIEW_LABEL: Record<SalesView, string> = {
  summary: 'Summary',
  items: 'Items',
  details: 'Details',
};

/** Validate/normalize the sales sub-view (defaults to summary). */
export function resolveSalesView(raw?: string): SalesView {
  return (SALES_VIEWS as string[]).includes(raw ?? '') ? (raw as SalesView) : 'summary';
}

/**
 * Which shared controls each report tab renders. Controls appear only where the
 * underlying data honestly supports them (e.g. End of Day is keyed by payment
 * date, so a date-basis toggle would be meaningless there).
 */
export const REPORT_CONTROLS: Record<
  ReportKind,
  { basis: boolean; compare: boolean; activity: boolean }
> = {
  revenue: { basis: false, compare: false, activity: false },
  sales: { basis: true, compare: true, activity: true },
  merchandise: { basis: true, compare: true, activity: true },
  'taxes-fees': { basis: false, compare: false, activity: false },
  occupancy: { basis: false, compare: false, activity: true },
  'gift-cards': { basis: false, compare: false, activity: false },
  'end-of-day': { basis: false, compare: false, activity: false },
  'head-count': { basis: false, compare: false, activity: true },
};
