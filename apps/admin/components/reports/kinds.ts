/**
 * Report-kind constants and helpers — client-safe (no `server-only`, no DB).
 *
 * Kept separate from `queries.ts` (which is `server-only`) so client components
 * like the tab strip and export button can import the kind list/labels without
 * pulling the server-only data layer into a browser bundle.
 */

export type ReportKind = 'revenue' | 'taxes-fees' | 'occupancy';

export const REPORT_KINDS: ReportKind[] = ['revenue', 'taxes-fees', 'occupancy'];

/** Human label for a report kind (tabs, filenames, headings). */
export const REPORT_LABEL: Record<ReportKind, string> = {
  revenue: 'Revenue',
  'taxes-fees': 'Taxes & Fees',
  occupancy: 'Occupancy',
};

/** Validate/normalize an arbitrary string into a known report kind (defaults to revenue). */
export function resolveReportKind(raw?: string): ReportKind {
  return (REPORT_KINDS as string[]).includes(raw ?? '') ? (raw as ReportKind) : 'revenue';
}
