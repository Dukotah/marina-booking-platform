import 'server-only';
import { getOperatorContext, getTenantDb } from '../../lib/session';
import { type ReportKind, REPORT_KINDS, resolveReportKind } from './kinds';

export { type ReportKind, REPORT_KINDS, resolveReportKind };

/**
 * Reports data layer.
 *
 * Every read goes through the tenant-scoped client (`getTenantDb`), so RLS scopes
 * results to the current operator. We still write explicit `operator_id`
 * where-clauses (defense in depth — never rely on RLS alone for correctness).
 *
 * All money is integer cents. Revenue is attributed by `Order.created_at` (when
 * the booking transaction was made) — the same convention the dashboard uses, so
 * the two never disagree. Cancelled / no-show orders are excluded from revenue.
 *
 * Everything degrades gracefully with no data: sums come back 0 and the daily
 * series is a zero-filled run of days across the selected range, so charts and
 * tables render an empty baseline rather than breaking (zero 404s, zero blanks).
 */

/** Order statuses that represent live, recognized revenue. */
const REVENUE_STATUSES = ['UPCOMING', 'COMPLETED'] as const;

/** A bounded date range (inclusive `from` day, inclusive `to` day). */
export interface DateRange {
  /** Local ISO date (YYYY-MM-DD), inclusive. */
  from: string;
  /** Local ISO date (YYYY-MM-DD), inclusive. */
  to: string;
}

/** Local ISO date string (YYYY-MM-DD) for the given date, no UTC shift. */
function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a YYYY-MM-DD string into a local Date at 00:00:00.000. */
function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
}

/** Start of the local day for the given date (00:00:00.000). */
function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Add `n` days to a copy of `d`. */
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/**
 * Resolve a raw `from`/`to` pair (possibly missing or reversed) into a valid,
 * ordered, half-open `[start, endExclusive)` window plus the normalized ISO
 * strings. Defaults to the trailing 30 days (including today) when absent.
 */
export function resolveRange(rawFrom?: string, rawTo?: string): {
  range: DateRange;
  start: Date;
  /** Exclusive end = start of the day after `to`. */
  endExclusive: Date;
  /** Number of whole days spanned (inclusive). */
  days: number;
} {
  const isIso = (s?: string): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

  const today = startOfDay(new Date());
  let start = isIso(rawFrom) ? parseIsoDate(rawFrom) : addDays(today, -29);
  let end = isIso(rawTo) ? parseIsoDate(rawTo) : today;

  // Guard against a reversed range (user picked end before start).
  if (start.getTime() > end.getTime()) {
    const tmp = start;
    start = end;
    end = tmp;
  }

  const endExclusive = addDays(end, 1);
  const days = Math.round((endExclusive.getTime() - start.getTime()) / 86_400_000);

  return {
    range: { from: isoDate(start), to: isoDate(end) },
    start,
    endExclusive,
    days,
  };
}

// ---------------------------------------------------------------------------
// Revenue report
// ---------------------------------------------------------------------------

export interface RevenueDayPoint {
  /** ISO date (YYYY-MM-DD) bucket. */
  date: string;
  /** Gross revenue (order totals) recognized that day, integer cents. */
  grossCents: number;
  /** Number of orders created that day. */
  orders: number;
}

export interface RevenueReport {
  range: DateRange;
  totals: {
    grossCents: number;
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    processingFeeCents: number;
    tipCents: number;
    /** Net of discounts and excluding tax/fees/tips = taxable goods value. */
    netSalesCents: number;
    orders: number;
    /** Average order value (gross / orders), integer cents (0 when no orders). */
    avgOrderValueCents: number;
  };
  /** Zero-filled daily series across the range, oldest → newest. */
  daily: RevenueDayPoint[];
  /** Revenue rolled up per activity (highest gross first). */
  byActivity: Array<{
    activityId: string;
    activityName: string;
    color: string;
    grossCents: number;
    bookings: number;
    seats: number;
  }>;
}

/** A loaded tenant client (typed once, reused by the helpers). */
type Db = Awaited<ReturnType<typeof getTenantDb>>;

async function buildRevenueReport(
  db: Db,
  operatorId: string,
  start: Date,
  endExclusive: Date,
  range: DateRange,
): Promise<RevenueReport> {
  // Pull the live orders in-window once; we derive every revenue figure from this
  // single set so the headline totals, daily series, and stored-column sums can
  // never disagree with each other.
  const orders = await db.order.findMany({
    where: {
      operator_id: operatorId,
      status: { in: [...REVENUE_STATUSES] },
      created_at: { gte: start, lt: endExclusive },
    },
    select: {
      created_at: true,
      subtotal_cents: true,
      discount_cents: true,
      tax_cents: true,
      processing_fee_cents: true,
      tip_cents: true,
      total_cents: true,
    },
  });

  // Zero-filled daily buckets across the whole range.
  const buckets = new Map<string, RevenueDayPoint>();
  for (let cur = new Date(start); cur < endExclusive; cur = addDays(cur, 1)) {
    const key = isoDate(cur);
    buckets.set(key, { date: key, grossCents: 0, orders: 0 });
  }

  const totals = {
    grossCents: 0,
    subtotalCents: 0,
    discountCents: 0,
    taxCents: 0,
    processingFeeCents: 0,
    tipCents: 0,
    netSalesCents: 0,
    orders: 0,
    avgOrderValueCents: 0,
  };

  for (const o of orders) {
    totals.grossCents += o.total_cents;
    totals.subtotalCents += o.subtotal_cents;
    totals.discountCents += o.discount_cents;
    totals.taxCents += o.tax_cents;
    totals.processingFeeCents += o.processing_fee_cents;
    totals.tipCents += o.tip_cents;
    totals.orders += 1;

    const key = isoDate(startOfDay(o.created_at));
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.grossCents += o.total_cents;
      bucket.orders += 1;
    }
  }

  totals.netSalesCents = totals.subtotalCents - totals.discountCents;
  totals.avgOrderValueCents = totals.orders
    ? Math.round(totals.grossCents / totals.orders)
    : 0;

  const byActivity = await buildRevenueByActivity(db, operatorId, start, endExclusive);

  return {
    range,
    totals,
    daily: Array.from(buckets.values()),
    byActivity,
  };
}

/**
 * Revenue per activity. We attribute an order item's line revenue
 * (`unit_price_cents * quantity`) to its activity. This is pre-tax/-fee line
 * value (taxes and processing fees are order-level, not per-line), so it rolls
 * up to the order subtotal — the right denominator for "which activity earns".
 */
async function buildRevenueByActivity(
  db: Db,
  operatorId: string,
  start: Date,
  endExclusive: Date,
): Promise<RevenueReport['byActivity']> {
  const items = await db.orderItem.findMany({
    where: {
      operator_id: operatorId,
      order: {
        status: { in: [...REVENUE_STATUSES] },
        created_at: { gte: start, lt: endExclusive },
      },
    },
    select: {
      quantity: true,
      unit_price_cents: true,
      activity: { select: { id: true, name_external: true, color: true } },
    },
  });

  const byActivity = new Map<string, RevenueReport['byActivity'][number]>();
  for (const it of items) {
    const a = it.activity;
    const lineCents = it.unit_price_cents * it.quantity;
    const existing = byActivity.get(a.id);
    if (existing) {
      existing.grossCents += lineCents;
      existing.bookings += 1;
      existing.seats += it.quantity;
    } else {
      byActivity.set(a.id, {
        activityId: a.id,
        activityName: a.name_external,
        color: a.color,
        grossCents: lineCents,
        bookings: 1,
        seats: it.quantity,
      });
    }
  }

  return Array.from(byActivity.values()).sort((x, y) => y.grossCents - x.grossCents);
}

// ---------------------------------------------------------------------------
// Taxes & fees report
// ---------------------------------------------------------------------------

export interface TaxesFeesReport {
  range: DateRange;
  totals: {
    taxableBaseCents: number; // subtotal - discount
    taxCents: number;
    processingFeeCents: number;
    discountCents: number;
    tipCents: number;
    orders: number;
  };
  /** The operator's configured fee schedule (so the report explains the rates). */
  configuredFees: Array<{
    id: string;
    name: string;
    type: 'PERCENT' | 'FLAT';
    value: number;
    scope: string; // activity name, or "All activities"
    enabled: boolean;
  }>;
  /** Zero-filled daily series of collected tax + processing fees. */
  daily: Array<{
    date: string;
    taxCents: number;
    processingFeeCents: number;
  }>;
}

async function buildTaxesFeesReport(
  db: Db,
  operatorId: string,
  start: Date,
  endExclusive: Date,
  range: DateRange,
): Promise<TaxesFeesReport> {
  const [orders, fees] = await Promise.all([
    db.order.findMany({
      where: {
        operator_id: operatorId,
        status: { in: [...REVENUE_STATUSES] },
        created_at: { gte: start, lt: endExclusive },
      },
      select: {
        created_at: true,
        subtotal_cents: true,
        discount_cents: true,
        tax_cents: true,
        processing_fee_cents: true,
        tip_cents: true,
      },
    }),
    db.fee.findMany({
      where: { operator_id: operatorId },
      select: {
        id: true,
        name: true,
        type: true,
        value: true,
        enabled: true,
        activity: { select: { name_external: true } },
      },
      orderBy: [{ enabled: 'desc' }, { name: 'asc' }],
    }),
  ]);

  const buckets = new Map<string, { date: string; taxCents: number; processingFeeCents: number }>();
  for (let cur = new Date(start); cur < endExclusive; cur = addDays(cur, 1)) {
    const key = isoDate(cur);
    buckets.set(key, { date: key, taxCents: 0, processingFeeCents: 0 });
  }

  const totals = {
    taxableBaseCents: 0,
    taxCents: 0,
    processingFeeCents: 0,
    discountCents: 0,
    tipCents: 0,
    orders: 0,
  };

  for (const o of orders) {
    totals.taxableBaseCents += o.subtotal_cents - o.discount_cents;
    totals.taxCents += o.tax_cents;
    totals.processingFeeCents += o.processing_fee_cents;
    totals.discountCents += o.discount_cents;
    totals.tipCents += o.tip_cents;
    totals.orders += 1;

    const bucket = buckets.get(isoDate(startOfDay(o.created_at)));
    if (bucket) {
      bucket.taxCents += o.tax_cents;
      bucket.processingFeeCents += o.processing_fee_cents;
    }
  }

  return {
    range,
    totals,
    configuredFees: fees.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      value: f.value,
      scope: f.activity?.name_external ?? 'All activities',
      enabled: f.enabled,
    })),
    daily: Array.from(buckets.values()),
  };
}

// ---------------------------------------------------------------------------
// Occupancy report
// ---------------------------------------------------------------------------

export interface OccupancyReport {
  range: DateRange;
  totals: {
    capacityTotal: number;
    capacityBooked: number;
    /** Booked / total, 0–1 (0 when no capacity). */
    ratio: number;
    /** Distinct non-cancelled timeslots in the window. */
    slots: number;
  };
  /** Zero-filled daily occupancy across the range. */
  daily: Array<{
    date: string;
    capacityTotal: number;
    capacityBooked: number;
    ratio: number;
  }>;
  /** Occupancy rolled up per activity (busiest first). */
  byActivity: Array<{
    activityId: string;
    activityName: string;
    color: string;
    capacityTotal: number;
    capacityBooked: number;
    ratio: number;
    slots: number;
  }>;
}

async function buildOccupancyReport(
  db: Db,
  operatorId: string,
  start: Date,
  endExclusive: Date,
  range: DateRange,
): Promise<OccupancyReport> {
  // Occupancy is keyed by the timeslot's scheduled datetime (when the activity
  // actually runs), not order created_at — that's what "occupancy on a day" means.
  const slots = await db.timeslot.findMany({
    where: {
      operator_id: operatorId,
      status: { not: 'CANCELLED' },
      datetime: { gte: start, lt: endExclusive },
    },
    select: {
      datetime: true,
      capacity_total: true,
      capacity_booked: true,
      activity: { select: { id: true, name_external: true, color: true } },
    },
  });

  const dayBuckets = new Map<string, { date: string; capacityTotal: number; capacityBooked: number; ratio: number }>();
  for (let cur = new Date(start); cur < endExclusive; cur = addDays(cur, 1)) {
    const key = isoDate(cur);
    dayBuckets.set(key, { date: key, capacityTotal: 0, capacityBooked: 0, ratio: 0 });
  }

  const byActivity = new Map<string, OccupancyReport['byActivity'][number]>();
  let capacityTotal = 0;
  let capacityBooked = 0;

  for (const s of slots) {
    capacityTotal += s.capacity_total;
    capacityBooked += s.capacity_booked;

    const dayKey = isoDate(startOfDay(s.datetime));
    const day = dayBuckets.get(dayKey);
    if (day) {
      day.capacityTotal += s.capacity_total;
      day.capacityBooked += s.capacity_booked;
    }

    const a = s.activity;
    const existing = byActivity.get(a.id);
    if (existing) {
      existing.capacityTotal += s.capacity_total;
      existing.capacityBooked += s.capacity_booked;
      existing.slots += 1;
    } else {
      byActivity.set(a.id, {
        activityId: a.id,
        activityName: a.name_external,
        color: a.color,
        capacityTotal: s.capacity_total,
        capacityBooked: s.capacity_booked,
        ratio: 0,
        slots: 1,
      });
    }
  }

  for (const day of dayBuckets.values()) {
    day.ratio = day.capacityTotal ? day.capacityBooked / day.capacityTotal : 0;
  }

  const byActivityList = Array.from(byActivity.values())
    .map((a) => ({ ...a, ratio: a.capacityTotal ? a.capacityBooked / a.capacityTotal : 0 }))
    .sort((x, y) => y.ratio - x.ratio);

  return {
    range,
    totals: {
      capacityTotal,
      capacityBooked,
      ratio: capacityTotal ? capacityBooked / capacityTotal : 0,
      slots: slots.length,
    },
    daily: Array.from(dayBuckets.values()),
    byActivity: byActivityList,
  };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export interface ReportsBundle {
  /** Operator brand color (hex) — keeps charts white-label. */
  brandColor: string;
  range: DateRange;
  revenue: RevenueReport;
  taxesFees: TaxesFeesReport;
  occupancy: OccupancyReport;
}

/**
 * Load all three reports for the resolved range in one tenant-scoped pass. The
 * page renders one at a time (tabbed), but loading all three together keeps the
 * page snappy when switching tabs and lets the CSV export cover any of them
 * without a refetch. Resolves the operator from the session, then runs every
 * read through the RLS client.
 */
export async function getReportsBundle(rawFrom?: string, rawTo?: string): Promise<ReportsBundle> {
  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();
  const { range, start, endExclusive } = resolveRange(rawFrom, rawTo);

  const [operator, revenue, taxesFees, occupancy] = await Promise.all([
    db.operator.findUnique({
      where: { id: operatorId },
      select: { brand_color: true },
    }),
    buildRevenueReport(db, operatorId, start, endExclusive, range),
    buildTaxesFeesReport(db, operatorId, start, endExclusive, range),
    buildOccupancyReport(db, operatorId, start, endExclusive, range),
  ]);

  return {
    brandColor: operator?.brand_color || '#0ea5e9',
    range,
    revenue,
    taxesFees,
    occupancy,
  };
}
