/**
 * Accounting API — the back-office export a bookkeeper reconciles a day with.
 *
 *   GET /summary         staff — the whole run as JSON (journal, reconciliation, tax)
 *   GET /export          staff — a downloadable QuickBooks / Xero / CSV file
 *   GET /tax             staff — sales-tax remittance for the period
 *   GET /reconciliation  staff — just the proof that the period balances
 *   GET /accounts        staff — the resolved chart of accounts, to check the mapping
 *   GET /exports         staff — past export runs (the receipt trail)
 *
 * Every route is scoped to the tenant by RLS and gated on `operator:manage`,
 * which is the permission the rest of the back office already uses. The math
 * lives in `@marina/core/accounting`; the data fetch lives in
 * `services/accounting.ts`. This file only parses, dispatches and renders.
 *
 * NOT mounted in app.ts — see the integration note in the handoff.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import {
  AccountingError as AccountingMathError,
  CSV_BOM,
  EXPORT_FORMATS,
  resolveChart,
  type ExportFormat,
} from '@marina/core';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import {
  AccountingExportError,
  buildExportForPeriod,
  listAccountingExports,
  recordAccountingExport,
  resolvePeriod,
  serializeForDownload,
} from '../services/accounting.js';

export const accounting = new Hono<Env>();

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const periodQuerySchema = z
  .object({
    /** Operator-local calendar dates; `end` is INCLUSIVE ("June 1 to June 30"). */
    start: z.string().regex(DATE_ONLY, 'start must be YYYY-MM-DD').optional(),
    end: z.string().regex(DATE_ONLY, 'end must be YYYY-MM-DD').optional(),
    /** Exact UTC instants for a caller that already knows its boundaries. */
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional(),
    granularity: z.enum(['day', 'month', 'period']).optional(),
  })
  .refine((v) => (v.start ?? v.startAt) && (v.end ?? v.endAt), {
    message: 'Provide start+end (YYYY-MM-DD) or startAt+endAt (ISO datetimes)',
  });

const formatSchema = z.enum(EXPORT_FORMATS as [ExportFormat, ...ExportFormat[]]);

/**
 * GL remapping for one run, given as repeated `map=<KEY>=<CODE>` query params
 * (e.g. `?map=REVENUE:BOAT=4001&map=TIPS_PAYABLE=2310`). Anything malformed is
 * ignored rather than failing the export — a typo in a mapping should not stop
 * the bookkeeper getting the file, and the resolved chart is on `/accounts` for
 * them to check.
 */
function parseOverrides(raw: string[] | undefined): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const entry of raw ?? []) {
    const at = entry.lastIndexOf('=');
    if (at <= 0) continue;
    const key = entry.slice(0, at).trim().toUpperCase();
    const code = entry.slice(at + 1).trim();
    if (key && code) overrides[key] = code;
  }
  return overrides;
}

/** Map a service/math failure onto a clean status; anything else rethrows. */
function toErrorResponse(err: unknown): { body: { error: string; code: string }; status: 400 } | null {
  if (err instanceof AccountingExportError) {
    return { body: { error: err.message, code: err.code }, status: err.status as 400 };
  }
  if (err instanceof AccountingMathError) {
    // Fractional cents reached the export, which means a row in the database is
    // not integer cents. That is a data defect, not a bad request.
    return { body: { error: err.message, code: 'NON_INTEGER_CENTS' }, status: 422 as 400 };
  }
  return null;
}

/** Resolve the period and run the export — the shared prelude of every route below. */
async function run(c: Context<Env>) {
  const query = periodQuerySchema.safeParse(c.req.query());
  if (!query.success) {
    return { error: c.json({ error: 'Invalid request', issues: query.error.flatten() }, 400) } as const;
  }
  const period = await resolvePeriod(c.var.operatorId, query.data);
  const overrides = parseOverrides(c.req.queries('map'));
  const result = await buildExportForPeriod(c.var.operatorId, {
    start: period.start,
    end: period.end,
    taxGranularity: query.data.granularity,
    overrides,
  });
  return { period, overrides, result, granularity: query.data.granularity } as const;
}

/**
 * GET /api/accounting/summary — the whole run as JSON.
 * This is what the admin Accounting screen renders: the journal it is about to
 * export, the reconciliation that proves it, and every variance found.
 */
accounting.get('/summary', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  try {
    const out = await run(c);
    if ('error' in out) return out.error;
    const { result, period } = out;
    return c.json({
      operatorName: result.operatorName,
      timeZone: result.timeZone,
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
      journal: {
        journalNo: result.journal.journalNo,
        date: result.journal.date.toISOString(),
        memo: result.journal.memo,
        lines: result.journal.lines,
        debitsCents: result.journal.debitsCents,
        creditsCents: result.journal.creditsCents,
        balanced: result.journal.balanced,
      },
      reconciliation: result.reconciliation,
      tax: result.tax,
      gift: { ...result.gift, liabilityNowCents: result.giftLiabilityNowCents },
      revenueByCategory: result.revenueByCategory,
      issues: result.issues,
      chart: result.chart.list(),
      formats: EXPORT_FORMATS,
    });
  } catch (err) {
    const mapped = toErrorResponse(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

/**
 * GET /api/accounting/export?format=quickbooks-csv — the downloadable file.
 *
 * The run is written to `AccountingExport` unless `?record=false`, so re-running
 * the same window later can be checked against what was filed. The balance state
 * rides on response headers as well as the body: an out-of-balance export is
 * still returned (the bookkeeper needs to see WHAT is wrong) but it is never
 * returned silently.
 */
accounting.get('/export', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');

  const format = formatSchema.safeParse(c.req.query('format') ?? 'quickbooks-csv');
  if (!format.success) {
    return c.json(
      { error: `Unknown format. Supported: ${EXPORT_FORMATS.join(', ')}`, code: 'BAD_FORMAT' },
      400,
    );
  }

  try {
    const out = await run(c);
    if ('error' in out) return out.error;
    const { result, period, overrides, granularity } = out;
    const file = serializeForDownload(result, format.data);

    if (c.req.query('record') !== 'false') {
      await recordAccountingExport(c.var.operatorId, {
        format: format.data,
        period: { start: period.start, end: period.end, taxGranularity: granularity, overrides },
        result,
        generatedBy: c.var.auth.userId,
      });
    }

    // IIF is tab-delimited plain text and QuickBooks Desktop chokes on a BOM;
    // Excel needs one to read UTF-8 CSV correctly. Hence the split.
    const body = format.data === 'quickbooks-iif' ? file.body : CSV_BOM + file.body;
    return c.body(body, 200, {
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Cache-Control': 'no-store',
      'X-Accounting-Balanced': String(file.balanced),
      'X-Accounting-Variance-Cents': String(file.varianceCents),
      'X-Accounting-Rows': String(file.rowCount),
    });
  } catch (err) {
    const mapped = toErrorResponse(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

/**
 * GET /api/accounting/tax — taxable sales and tax collected per period.
 * `granularity=day|month|period`, `format=csv` for the file.
 */
accounting.get('/tax', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  try {
    const out = await run(c);
    if ('error' in out) return out.error;
    const { result } = out;
    if (c.req.query('format') === 'csv') {
      const file = serializeForDownload(result, 'tax-csv');
      return c.body(CSV_BOM + file.body, 200, {
        'Content-Type': file.contentType,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Cache-Control': 'no-store',
      });
    }
    return c.json({
      periodStart: result.periodStart.toISOString(),
      periodEnd: result.periodEnd.toISOString(),
      ...result.tax,
    });
  } catch (err) {
    const mapped = toErrorResponse(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

/**
 * GET /api/accounting/reconciliation — the proof, on its own.
 * `balanced: false` means the period does NOT reconcile; `issues` says why.
 */
accounting.get('/reconciliation', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  try {
    const out = await run(c);
    if ('error' in out) return out.error;
    const { result } = out;
    if (c.req.query('format') === 'csv') {
      const file = serializeForDownload(result, 'reconciliation-csv');
      return c.body(CSV_BOM + file.body, 200, {
        'Content-Type': file.contentType,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Cache-Control': 'no-store',
      });
    }
    return c.json({
      timeZone: result.timeZone,
      periodStart: result.periodStart.toISOString(),
      periodEnd: result.periodEnd.toISOString(),
      reconciliation: result.reconciliation,
      issues: result.issues,
    });
  } catch (err) {
    const mapped = toErrorResponse(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

/**
 * GET /api/accounting/accounts — the chart this operator's exports will post to,
 * after their GLAccount rows and any `map=` overrides are applied. Lets an
 * operator confirm the mapping BEFORE importing a file into their books.
 */
accounting.get('/accounts', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const rows = await c.var.db.gLAccount.findMany({
    select: { code: true, name: true, category: true, is_active: true },
    orderBy: { code: 'asc' },
  });
  const chart = resolveChart({ accounts: rows, overrides: parseOverrides(c.req.queries('map')) });
  return c.json({ accounts: chart.list(), glAccounts: rows });
});

/** GET /api/accounting/exports — past runs, newest first. */
accounting.get('/exports', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const limit = Number(c.req.query('limit') ?? 50);
  const rows = await listAccountingExports(
    c.var.operatorId,
    Number.isFinite(limit) ? limit : 50,
  );
  return c.json({ exports: rows });
});
