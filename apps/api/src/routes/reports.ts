/**
 * Reports API — read-only analytics for staff with `report:read` permission.
 *
 *   GET /api/reports/revenue         JSON revenue summary over a date range
 *   GET /api/reports/revenue.csv     Same data as CSV download
 *   GET /api/reports/bookings        JSON booking counts by status + top activities
 *   GET /api/reports/bookings.csv    Same data as CSV download
 *
 * All endpoints are staff-gated (requireStaff + assertPermission 'report:read').
 * All data access goes through `c.var.db` (the RLS-scoped tenant client).
 * Money is integer cents in JSON; CSV includes both cents and formatted dollar columns.
 * Default range: last 30 days. Accepts ?from=YYYY-MM-DD&to=YYYY-MM-DD.
 */
import { Hono } from 'hono';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';

export const reports = new Hono<Env>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse the ?from / ?to query params and return {from, to} as Date objects.
 *  Defaults to the last 30 days if omitted. Returns null if a supplied value
 *  is in an invalid format (routes respond 400 on null). */
function parseDateRange(
  fromParam: string | undefined,
  toParam: string | undefined,
): { from: Date; to: Date } | null {
  const now = new Date();

  let from: Date;
  let to: Date;

  if (fromParam !== undefined) {
    if (!DATE_RE.test(fromParam)) return null;
    from = new Date(`${fromParam}T00:00:00.000Z`);
    if (isNaN(from.getTime())) return null;
  } else {
    // Default: 30 days ago at midnight UTC
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30));
  }

  if (toParam !== undefined) {
    if (!DATE_RE.test(toParam)) return null;
    // inclusive: the "to" date means the end of that day (exclusive next day)
    to = new Date(`${toParam}T00:00:00.000Z`);
    if (isNaN(to.getTime())) return null;
    to = new Date(to.getTime() + 24 * 60 * 60 * 1000); // advance to start of NEXT day
  } else {
    // Default: end of today UTC (exclusive start of tomorrow)
    to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  }

  if (from >= to) return null;
  return { from, to };
}

/** Format cents as a USD dollar string for CSV columns (e.g. 15050 → "$150.50"). */
function centsToUSD(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/**
 * Escape a CSV cell value: wrap in quotes if it contains comma, double-quote,
 * or newline; double any internal double-quotes.
 */
function csvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Join an array of cell values into a CSV row string. */
function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(',');
}

// Revenue statuses — everything except CANCELLED counts as revenue.
const REVENUE_STATUSES = ['UPCOMING', 'COMPLETED', 'NO_SHOW'] as const;

// ---------------------------------------------------------------------------
// Revenue helpers
// ---------------------------------------------------------------------------

interface DayRevenue {
  date: string; // YYYY-MM-DD
  grossCents: number;
  discountCents: number;
  taxCents: number;
  tipCents: number;
  netCents: number;
  orderCount: number;
}

interface RevenueReport {
  from: string;
  to: string;
  grossCents: number;
  discountCents: number;
  taxCents: number;
  tipCents: number;
  refundCents: number;
  netCents: number;
  orderCount: number;
  byDay: DayRevenue[];
}

async function buildRevenueReport(
  db: Env['Variables']['db'],
  from: Date,
  to: Date,
): Promise<RevenueReport> {
  // Fetch all non-cancelled orders in range with their payments.
  const orders = await db.order.findMany({
    where: {
      status: { in: [...REVENUE_STATUSES] },
      created_at: { gte: from, lt: to },
    },
    select: {
      id: true,
      status: true,
      created_at: true,
      total_cents: true,
      discount_cents: true,
      tax_cents: true,
      tip_cents: true,
      payments: {
        select: { refunded_cents: true },
      },
    },
    orderBy: { created_at: 'asc' },
  });

  // Aggregate totals and per-day breakdown.
  const dayMap = new Map<string, DayRevenue>();

  let grossCents = 0;
  let discountCents = 0;
  let taxCents = 0;
  let tipCents = 0;
  let refundCents = 0;

  for (const order of orders) {
    const orderRefund = order.payments.reduce((sum, p) => sum + p.refunded_cents, 0);

    grossCents += order.total_cents;
    discountCents += order.discount_cents;
    taxCents += order.tax_cents;
    tipCents += order.tip_cents;
    refundCents += orderRefund;

    // Key by UTC date YYYY-MM-DD
    const dateKey = order.created_at.toISOString().slice(0, 10);
    const day = dayMap.get(dateKey) ?? {
      date: dateKey,
      grossCents: 0,
      discountCents: 0,
      taxCents: 0,
      tipCents: 0,
      netCents: 0,
      orderCount: 0,
    };
    day.grossCents += order.total_cents;
    day.discountCents += order.discount_cents;
    day.taxCents += order.tax_cents;
    day.tipCents += order.tip_cents;
    day.orderCount += 1;
    dayMap.set(dateKey, day);
  }

  // Compute net for each day after all orders have been summed.
  const byDay = Array.from(dayMap.values()).map((d) => ({
    ...d,
    netCents: d.grossCents - d.discountCents - refundCents, // approximate per-day net
  }));

  // Sort by date ascending.
  byDay.sort((a, b) => a.date.localeCompare(b.date));

  const netCents = grossCents - discountCents - refundCents;

  return {
    from: from.toISOString().slice(0, 10),
    to: new Date(to.getTime() - 1).toISOString().slice(0, 10), // inclusive end for display
    grossCents,
    discountCents,
    taxCents,
    tipCents,
    refundCents,
    netCents,
    orderCount: orders.length,
    byDay,
  };
}

// ---------------------------------------------------------------------------
// Bookings helpers
// ---------------------------------------------------------------------------

interface ActivityStat {
  activityId: string;
  activityName: string;
  bookingCount: number;
  totalQuantity: number;
}

interface BookingsReport {
  from: string;
  to: string;
  byStatus: Record<string, number>;
  topActivities: ActivityStat[];
}

async function buildBookingsReport(
  db: Env['Variables']['db'],
  from: Date,
  to: Date,
): Promise<BookingsReport> {
  // Count orders by status in range.
  const statusGroups = await db.order.groupBy({
    by: ['status'],
    where: { created_at: { gte: from, lt: to } },
    _count: { id: true },
  });

  const byStatus: Record<string, number> = {
    UPCOMING: 0,
    COMPLETED: 0,
    CANCELLED: 0,
    NO_SHOW: 0,
  };
  for (const g of statusGroups) {
    byStatus[g.status] = g._count.id;
  }

  // Top activities by booking (order item) count and quantity in range.
  const items = await db.orderItem.findMany({
    where: {
      order: { created_at: { gte: from, lt: to } },
    },
    select: {
      activity_id: true,
      quantity: true,
      activity: { select: { name_external: true } },
    },
  });

  // Aggregate per activity.
  const actMap = new Map<string, { name: string; count: number; qty: number }>();
  for (const item of items) {
    const existing = actMap.get(item.activity_id) ?? {
      name: item.activity.name_external,
      count: 0,
      qty: 0,
    };
    existing.count += 1;
    existing.qty += item.quantity;
    actMap.set(item.activity_id, existing);
  }

  const topActivities: ActivityStat[] = Array.from(actMap.entries())
    .map(([activityId, v]) => ({
      activityId,
      activityName: v.name,
      bookingCount: v.count,
      totalQuantity: v.qty,
    }))
    .sort((a, b) => b.bookingCount - a.bookingCount)
    .slice(0, 20); // top 20

  return {
    from: from.toISOString().slice(0, 10),
    to: new Date(to.getTime() - 1).toISOString().slice(0, 10),
    byStatus,
    topActivities,
  };
}

// ---------------------------------------------------------------------------
// GET /revenue — JSON revenue summary
// ---------------------------------------------------------------------------

reports.get('/revenue', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'report:read');

  const range = parseDateRange(c.req.query('from'), c.req.query('to'));
  if (!range) {
    return c.json({ error: 'Invalid date range. Use ?from=YYYY-MM-DD&to=YYYY-MM-DD' }, 400);
  }

  const report = await buildRevenueReport(c.var.db, range.from, range.to);
  return c.json({ report });
});

// ---------------------------------------------------------------------------
// GET /revenue.csv — CSV download of revenue summary
// ---------------------------------------------------------------------------

reports.get('/revenue.csv', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'report:read');

  const range = parseDateRange(c.req.query('from'), c.req.query('to'));
  if (!range) {
    return c.json({ error: 'Invalid date range. Use ?from=YYYY-MM-DD&to=YYYY-MM-DD' }, 400);
  }

  const report = await buildRevenueReport(c.var.db, range.from, range.to);

  const filename = `revenue-${report.from}-to-${report.to}.csv`;
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);

  const lines: string[] = [];

  // Summary section
  lines.push(csvRow(['Report', 'Revenue Summary']));
  lines.push(csvRow(['Period', `${report.from} to ${report.to}`]));
  lines.push('');
  lines.push(csvRow(['Metric', 'Cents', 'USD']));
  lines.push(csvRow(['Gross Sales', report.grossCents, centsToUSD(report.grossCents)]));
  lines.push(csvRow(['Discounts', report.discountCents, centsToUSD(report.discountCents)]));
  lines.push(csvRow(['Tax', report.taxCents, centsToUSD(report.taxCents)]));
  lines.push(csvRow(['Tips', report.tipCents, centsToUSD(report.tipCents)]));
  lines.push(csvRow(['Refunds', report.refundCents, centsToUSD(report.refundCents)]));
  lines.push(csvRow(['Net Revenue', report.netCents, centsToUSD(report.netCents)]));
  lines.push(csvRow(['Order Count', report.orderCount, '']));
  lines.push('');

  // Per-day breakdown
  lines.push(csvRow(['Date', 'Gross Cents', 'Gross USD', 'Discount Cents', 'Tax Cents', 'Tip Cents', 'Net Cents', 'Net USD', 'Order Count']));
  for (const day of report.byDay) {
    lines.push(
      csvRow([
        day.date,
        day.grossCents,
        centsToUSD(day.grossCents),
        day.discountCents,
        day.taxCents,
        day.tipCents,
        day.netCents,
        centsToUSD(day.netCents),
        day.orderCount,
      ]),
    );
  }

  return c.body(lines.join('\r\n'));
});

// ---------------------------------------------------------------------------
// GET /bookings — JSON bookings summary
// ---------------------------------------------------------------------------

reports.get('/bookings', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'report:read');

  const range = parseDateRange(c.req.query('from'), c.req.query('to'));
  if (!range) {
    return c.json({ error: 'Invalid date range. Use ?from=YYYY-MM-DD&to=YYYY-MM-DD' }, 400);
  }

  const report = await buildBookingsReport(c.var.db, range.from, range.to);
  return c.json({ report });
});

// ---------------------------------------------------------------------------
// GET /bookings.csv — CSV download of bookings summary
// ---------------------------------------------------------------------------

reports.get('/bookings.csv', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'report:read');

  const range = parseDateRange(c.req.query('from'), c.req.query('to'));
  if (!range) {
    return c.json({ error: 'Invalid date range. Use ?from=YYYY-MM-DD&to=YYYY-MM-DD' }, 400);
  }

  const report = await buildBookingsReport(c.var.db, range.from, range.to);

  const filename = `bookings-${report.from}-to-${report.to}.csv`;
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);

  const lines: string[] = [];

  // Status breakdown section
  lines.push(csvRow(['Report', 'Bookings Summary']));
  lines.push(csvRow(['Period', `${report.from} to ${report.to}`]));
  lines.push('');
  lines.push(csvRow(['Status', 'Count']));
  for (const [status, count] of Object.entries(report.byStatus)) {
    lines.push(csvRow([status, count]));
  }
  lines.push('');

  // Top activities section
  lines.push(csvRow(['Activity ID', 'Activity Name', 'Booking Count', 'Total Quantity']));
  for (const act of report.topActivities) {
    lines.push(csvRow([act.activityId, act.activityName, act.bookingCount, act.totalQuantity]));
  }

  return c.body(lines.join('\r\n'));
});
