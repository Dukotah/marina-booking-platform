'use server';

import { AuthorizationError } from '@marina/auth';
import { requirePermission } from '../../lib/session';
import { getReportsBundle, resolveReportKind } from '../../components/reports/queries';
import { buildReportCsv, REPORT_LABEL } from '../../components/reports/export';
import { reportFilename, withBom } from '../../components/reports/csv';

/**
 * Server action that generates a report CSV on the server and returns it to the
 * client for download. This is the authoritative export path: it re-derives the
 * operator from the session (never trusting client input), runs every read
 * through the tenant-scoped RLS client, and requires `report:read` — so one
 * operator can never export another's data.
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
  const bundle = await getReportsBundle(rawFrom, rawTo);

  const csv = buildReportCsv(kind, bundle);
  const filename = reportFilename(REPORT_LABEL[kind], bundle.range.from, bundle.range.to);

  return { ok: true, filename, csv: withBom(csv) };
}
