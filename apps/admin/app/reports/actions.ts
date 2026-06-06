'use server';

import { AuthorizationError } from '@marina/auth';
import { requirePermission } from '../../lib/session';
import { getReportsBundle, resolveReportKind, resolveRange } from '../../components/reports/queries';
import { buildReportCsv, REPORT_LABEL } from '../../components/reports/export';
import { reportFilename, withBom } from '../../components/reports/csv';
import { apiGet } from '../../lib/apiClient';
import type { LocationReport } from '../../components/reports/ByLocationReportView';
import type { TransactionsReport } from '../../components/reports/TransactionsReportView';

/**
 * Server action that generates a report CSV on the server and returns it to the
 * client for download. This is the authoritative export path: it re-derives the
 * operator from the session (never trusting client input), runs every read
 * through the tenant-scoped RLS client, and requires `report:read` — so one
 * operator can never export another's data.
 *
 * The by-location and transactions kinds fetch from the API (which owns that
 * aggregation logic, D-020/D-021) instead of going direct-to-DB. All other
 * kinds continue reading via queries.ts as before.
 *
 * The client component calls this, then triggers a Blob download of the returned
 * string. (A pure client-side export off the already-rendered data is also wired
 * up as a zero-round-trip fallback.)
 */
export interface ExportCsvResult {
  ok: boolean;
  filename?: string;
  /** CSV body, BOM-prefixed and ready to drop straight into a Blob. */
  csv?: string;
  error?: string;
}

export async function exportReportCsv(
  rawKind: string,
  rawFrom?: string,
  rawTo?: string,
): Promise<ExportCsvResult> {
  try {
    await requirePermission('report:read');
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: 'You do not have permission to export reports.' };
    }
    throw err;
  }

  const kind = resolveReportKind(rawKind);

  // For the two API-sourced kinds, fetch from the API and build CSV from that.
  if (kind === 'by-location' || kind === 'transactions') {
    const { range } = resolveRange(rawFrom, rawTo);
    const query = { from: range.from, to: range.to };

    try {
      if (kind === 'by-location') {
        const { report } = await apiGet<{ report: LocationReport }>('/api/reports/by-location', query);
        const csv = buildReportCsv('by-location', {
          revenue: undefined as never,
          taxesFees: undefined as never,
          occupancy: undefined as never,
          byLocation: report,
        });
        return {
          ok: true,
          filename: reportFilename(REPORT_LABEL['by-location'], range.from, range.to),
          csv: withBom(csv),
        };
      } else {
        const { report } = await apiGet<{ report: TransactionsReport }>('/api/reports/transactions', query);
        const csv = buildReportCsv('transactions', {
          revenue: undefined as never,
          taxesFees: undefined as never,
          occupancy: undefined as never,
          transactions: report,
        });
        return {
          ok: true,
          filename: reportFilename(REPORT_LABEL['transactions'], range.from, range.to),
          csv: withBom(csv),
        };
      }
    } catch {
      return { ok: false, error: 'Failed to fetch report data from the API. Please try again.' };
    }
  }

  // Existing three kinds: read via queries.ts (direct DB, unchanged).
  const bundle = await getReportsBundle(rawFrom, rawTo);
  const csv = buildReportCsv(kind, bundle);
  const filename = reportFilename(REPORT_LABEL[kind], bundle.range.from, bundle.range.to);

  return { ok: true, filename, csv: withBom(csv) };
}
