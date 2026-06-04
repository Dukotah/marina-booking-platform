/**
 * CSV helpers shared by the reports server action and client-side export button.
 *
 * Pure + framework-agnostic so the exact same serialization is used whether the
 * CSV is produced on the server (a server action returning the string) or in the
 * browser (instant download from data already on the page). One implementation =
 * no drift between the two paths.
 *
 * RFC-4180-ish: fields containing a comma, double-quote, or newline are wrapped
 * in double-quotes with internal quotes doubled. A leading BOM is prepended so
 * Excel opens UTF-8 cleanly.
 */

export type CsvCell = string | number | null | undefined;
export type CsvRow = CsvCell[];

/** Quote a single cell when it contains a delimiter, quote, or newline. */
function escapeCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'number' ? String(value) : value;
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialize a header + rows into a CSV string. CRLF line endings (the CSV
 * standard, and what spreadsheet apps expect).
 */
export function toCsv(header: readonly string[], rows: readonly CsvRow[]): string {
  const lines: string[] = [];
  lines.push(header.map(escapeCell).join(','));
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(','));
  }
  return lines.join('\r\n');
}

/** UTF-8 BOM so Excel detects the encoding and renders accented text correctly. */
const BOM = '﻿';

/** Prepend the BOM for file output (kept separate so the raw CSV stays clean). */
export function withBom(csv: string): string {
  return BOM + csv;
}

/**
 * Trigger a client-side download of a CSV string. No-op on the server. Uses a
 * Blob URL so nothing round-trips through the network — the data is already on
 * the page.
 */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([withBom(csv)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** A filesystem-safe report filename: "revenue_2026-06-01_2026-06-30.csv". */
export function reportFilename(report: string, from: string, to: string): string {
  const safe = report.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return `${safe}_${from}_${to}.csv`;
}
