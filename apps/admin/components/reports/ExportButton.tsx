'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@marina/ui';
import { exportReportCsv } from '../../app/reports/actions';
import { downloadCsv } from './csv';
import type { ReportKind } from './kinds';

export interface ExportButtonProps {
  /** Which report to export. */
  reportKind: ReportKind;
  /** Resolved range (ISO YYYY-MM-DD) — passed to the server action. */
  from: string;
  to: string;
}

/**
 * Triggers a CSV export of the current report. The authoritative path is the
 * `exportReportCsv` server action (permission-gated, tenant-scoped); we download
 * the string it returns as a Blob, so the bytes never round-trip through a public
 * URL. Errors (e.g. missing permission) surface inline rather than failing
 * silently.
 */
export function ExportButton({ reportKind, from, to }: ExportButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setBusy(true);
    setError(null);
    try {
      const result = await exportReportCsv(reportKind, from, to);
      if (!result.ok || !result.csv || !result.filename) {
        setError(result.error ?? 'Export failed. Please try again.');
        return;
      }
      downloadCsv(result.filename, result.csv);
    } catch {
      setError('Export failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" variant="outline" size="sm" loading={busy} onClick={handleExport}>
        {!busy ? <Download className="h-4 w-4" aria-hidden /> : null}
        Export CSV
      </Button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
