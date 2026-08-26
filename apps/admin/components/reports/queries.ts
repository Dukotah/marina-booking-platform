import 'server-only';
import {
  computeDelta,
  previousPeriod,
  resolveDateBasis,
  rollUpByLocation,
  summarizePayments,
  type DateBasis,
  type Delta,
  type LocationMetricRow,
  type LocationRollUp,
  type PaymentsSummary,
} from '@marina/core';
import { getOperatorContext, getTenantDb } from '../../lib/session';
import { type ReportKind, REPORT_KINDS, resolveReportKind } from './kinds';

export { type ReportKind, REPORT_KINDS, resolveReportKind };
export { resolveDateBasis, type DateBasis };

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
// Sales report (gross / taxes & fees / tips / merch / packages / payments)
// ---------------------------------------------------------------------------

/**
 * Resolve, for each live order in the operator, the date it attributes to under
 * the given basis:
 *   - `order`: Order.created_at (transaction date).
 *   - `appointment`: the EARLIEST timeslot datetime among the order's items (the
 *     day the guest is actually scheduled). Orders with no dated items fall back
 *     to created_at so nothing silently vanishes.
 *
 * Returns a map orderId -> attributed local ISO date. Only orders whose
 * attributed date lands inside `[start, endExclusive)` are included, so callers
 * can filter a superset of orders down to the in-window set for either basis.
 */
async function resolveOrderDates(
  db: Db,
  operatorId: string,
  start: Date,
  endExclusive: Date,
  basis: DateBasis,
): Promise<Map<string, string>> {
  if (basis === 'order') {
    const orders = await db.order.findMany({
      where: {
        operator_id: operatorId,
        status: { in: [...REVENUE_STATUSES] },
        created_at: { gte: start, lt: endExclusive },
      },
      select: { id: true, created_at: true },
    });
    return new Map(orders.map((o) => [o.id, isoDate(startOfDay(o.created_at))]));
  }

  // appointment basis: attribute by earliest item timeslot datetime.
  const items = await db.orderItem.findMany({
    where: {
      operator_id: operatorId,
      order: { status: { in: [...REVENUE_STATUSES] } },
      timeslot: { datetime: { gte: start, lt: endExclusive } },
    },
    select: { order_id: true, timeslot: { select: { datetime: true } } },
  });

  const earliest = new Map<string, Date>();
  for (const it of items) {
    const dt = it.timeslot.datetime;
    const cur = earliest.get(it.order_id);
    if (!cur || dt.getTime() < cur.getTime()) earliest.set(it.order_id, dt);
  }
  return new Map(Array.from(earliest.entries()).map(([id, dt]) => [id, isoDate(startOfDay(dt))]));
}

export interface SalesTotals {
  grossSalesCents: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  processingFeeCents: number;
  /** Tax + processing fees combined ("Taxes & Fees" headline). */
  taxesAndFeesCents: number;
  tipCents: number;
  /** Net taxable goods value (subtotal − discount). */
  netSalesCents: number;
  orders: number;
}

export interface SalesReport {
  range: DateRange;
  basis: DateBasis;
  totals: SalesTotals;
  /** Payments rolled up by tender method (card / cash / gift card / comp). */
  payments: PaymentsSummary;
  /**
   * Merchandise + packages breakouts. The current data model records merchandise
   * only as inventory decrements and order subtotal (no per-order merch line),
   * and there is no packages feature at all — so these are reported as
   * unavailable rather than shown as a misleading $0. `null` = feature/data not
   * tracked (render a graceful "not tracked" note); a number = tracked value.
   */
  merchandiseCents: number | null;
  packagesCents: number | null;
  /** Present only in comparison mode: same totals for the prior window + deltas. */
  comparison?: {
    range: DateRange;
    totals: SalesTotals;
    deltas: {
      grossSalesCents: Delta;
      taxesAndFeesCents: Delta;
      tipCents: Delta;
      netSalesCents: Delta;
      orders: Delta;
    };
  };
}

async function computeSalesTotals(
  db: Db,
  operatorId: string,
  start: Date,
  endExclusive: Date,
  basis: DateBasis,
): Promise<{ totals: SalesTotals; payments: PaymentsSummary }> {
  const orderDates = await resolveOrderDates(db, operatorId, start, endExclusive, basis);
  const orderIds = Array.from(orderDates.keys());

  const totals: SalesTotals = {
    grossSalesCents: 0,
    subtotalCents: 0,
    discountCents: 0,
    taxCents: 0,
    processingFeeCents: 0,
    taxesAndFeesCents: 0,
    tipCents: 0,
    netSalesCents: 0,
    orders: 0,
  };

  if (orderIds.length === 0) {
    return { totals, payments: summarizePayments([]) };
  }

  const [orders, payments] = await Promise.all([
    db.order.findMany({
      where: { operator_id: operatorId, id: { in: orderIds } },
      select: {
        subtotal_cents: true,
        discount_cents: true,
        tax_cents: true,
        processing_fee_cents: true,
        tip_cents: true,
        total_cents: true,
      },
    }),
    db.payment.findMany({
      where: { operator_id: operatorId, order_id: { in: orderIds }, status: { not: 'FAILED' } },
      select: { method: true, amount_cents: true, refunded_cents: true },
    }),
  ]);

  for (const o of orders) {
    totals.grossSalesCents += o.total_cents;
    totals.subtotalCents += o.subtotal_cents;
    totals.discountCents += o.discount_cents;
    totals.taxCents += o.tax_cents;
    totals.processingFeeCents += o.processing_fee_cents;
    totals.tipCents += o.tip_cents;
    totals.orders += 1;
  }
  totals.taxesAndFeesCents = totals.taxCents + totals.processingFeeCents;
  totals.netSalesCents = totals.subtotalCents - totals.discountCents;

  return { totals, payments: summarizePayments(payments) };
}

async function buildSalesReport(
  db: Db,
  operatorId: string,
  start: Date,
  endExclusive: Date,
  range: DateRange,
  basis: DateBasis,
  compare: boolean,
): Promise<SalesReport> {
  const current = await computeSalesTotals(db, operatorId, start, endExclusive, basis);

  const report: SalesReport = {
    range,
    basis,
    totals: current.totals,
    payments: current.payments,
    // No per-order merchandise line and no packages feature in the data model;
    // report as untracked rather than a misleading $0 (skip gracefully).
    merchandiseCents: null,
    packagesCents: null,
  };

  if (compare) {
    const prev = previousPeriod(start, endExclusive);
    const prevTotals = await computeSalesTotals(db, operatorId, prev.start, prev.endExclusive, basis);
    report.comparison = {
      range: { from: isoDate(prev.start), to: isoDate(addDays(prev.endExclusive, -1)) },
      totals: prevTotals.totals,
      deltas: {
        grossSalesCents: computeDelta(current.totals.grossSalesCents, prevTotals.totals.grossSalesCents),
        taxesAndFeesCents: computeDelta(
          current.totals.taxesAndFeesCents,
          prevTotals.totals.taxesAndFeesCents,
        ),
        tipCents: computeDelta(current.totals.tipCents, prevTotals.totals.tipCents),
        netSalesCents: computeDelta(current.totals.netSalesCents, prevTotals.totals.netSalesCents),
        orders: computeDelta(current.totals.orders, prevTotals.totals.orders),
      },
    };
  }

  return report;
}

// ---------------------------------------------------------------------------
// Gift-card report (outstanding liability + issued / redeemed)
// ---------------------------------------------------------------------------

export interface GiftCardReport {
  range: DateRange;
  /** Outstanding liability = sum(balance) of ACTIVE cards, at report time. */
  liabilityCents: number;
  /** Cards issued in the window: count + face value (initial balance). */
  issued: { count: number; amountCents: number };
  /**
   * Value redeemed in the window: sum of GIFT_CARD-method payments (amount less
   * refunds). This is money spent down off cards, matching the liability model.
   */
  redeemed: { count: number; amountCents: number };
  /** Snapshot of the current card book by status. */
  byStatus: Array<{ status: string; count: number; balanceCents: number }>;
}

async function buildGiftCardReport(
  db: Db,
  operatorId: string,
  start: Date,
  endExclusive: Date,
  range: DateRange,
): Promise<GiftCardReport> {
  const [liabilityAgg, issued, redemptionPayments, grouped] = await Promise.all([
    db.giftCard.aggregate({
      where: { operator_id: operatorId, status: 'ACTIVE' },
      _sum: { balance_cents: true },
    }),
    db.giftCard.findMany({
      where: { operator_id: operatorId, created_at: { gte: start, lt: endExclusive } },
      select: { initial_cents: true },
    }),
    db.payment.findMany({
      where: {
        operator_id: operatorId,
        method: 'GIFT_CARD',
        status: { not: 'FAILED' },
        processed_at: { gte: start, lt: endExclusive },
      },
      select: { amount_cents: true, refunded_cents: true },
    }),
    db.giftCard.groupBy({
      by: ['status'],
      where: { operator_id: operatorId },
      _count: { _all: true },
      _sum: { balance_cents: true },
    }),
  ]);

  const issuedAmount = issued.reduce((sum, g) => sum + g.initial_cents, 0);
  const redeemedAmount = redemptionPayments.reduce(
    (sum, p) => sum + (p.amount_cents - p.refunded_cents),
    0,
  );

  return {
    range,
    liabilityCents: liabilityAgg._sum.balance_cents ?? 0,
    issued: { count: issued.length, amountCents: issuedAmount },
    redeemed: { count: redemptionPayments.length, amountCents: redeemedAmount },
    byStatus: grouped
      .map((g) => ({
        status: g.status,
        count: g._count._all,
        balanceCents: g._sum.balance_cents ?? 0,
      }))
      .sort((a, b) => b.balanceCents - a.balanceCents),
  };
}

// ---------------------------------------------------------------------------
// Multi-location roll-up (Upmarket §1 #6-B) — read-only cross-location report
// ---------------------------------------------------------------------------

export interface LocationRollUpReport extends LocationRollUp {
  range: DateRange;
}

/**
 * Combined revenue + occupancy by location across the range. Revenue is attributed
 * to a location via each order item's activity → location (order-created_at basis,
 * matching the revenue report). Occupancy is attributed via each timeslot's
 * activity → location. Activities with no location roll up under an "Unassigned"
 * bucket. Every read is tenant-scoped (RLS) with an explicit operator_id clause.
 * The heavy lifting (occupancy / share / totals) is the pure @marina/core
 * `rollUpByLocation`, so this stays a thin data-loader.
 */
async function buildLocationRollUp(
  db: Db,
  operatorId: string,
  start: Date,
  endExclusive: Date,
  range: DateRange,
): Promise<LocationRollUpReport> {
  const [items, slots] = await Promise.all([
    db.orderItem.findMany({
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
        order_id: true,
        activity: { select: { location: { select: { id: true, name: true } } } },
      },
    }),
    db.timeslot.findMany({
      where: {
        operator_id: operatorId,
        status: { not: 'CANCELLED' },
        datetime: { gte: start, lt: endExclusive },
      },
      select: {
        capacity_total: true,
        capacity_booked: true,
        activity: { select: { location: { select: { id: true, name: true } } } },
      },
    }),
  ]);

  // Aggregate raw metrics keyed by location id (null => Unassigned).
  const byLoc = new Map<string, LocationMetricRow>();
  const ensure = (loc: { id: string; name: string } | null): LocationMetricRow => {
    const key = loc?.id ?? '__none__';
    let row = byLoc.get(key);
    if (!row) {
      row = {
        locationId: loc?.id ?? null,
        locationName: loc?.name ?? 'Unassigned',
        grossCents: 0,
        orders: 0,
        capacityBooked: 0,
        capacityTotal: 0,
      };
      byLoc.set(key, row);
    }
    return row;
  };

  // Revenue (line value) + distinct order counts per location.
  const ordersByLoc = new Map<string, Set<string>>();
  for (const it of items) {
    const row = ensure(it.activity.location);
    row.grossCents += it.unit_price_cents * it.quantity;
    const key = it.activity.location?.id ?? '__none__';
    const set = ordersByLoc.get(key) ?? new Set<string>();
    set.add(it.order_id);
    ordersByLoc.set(key, set);
  }
  for (const [key, set] of ordersByLoc) {
    const row = byLoc.get(key);
    if (row) row.orders = set.size;
  }

  // Occupancy per location.
  for (const s of slots) {
    const row = ensure(s.activity.location);
    row.capacityTotal += s.capacity_total;
    row.capacityBooked += s.capacity_booked;
  }

  const rollup = rollUpByLocation(Array.from(byLoc.values()));
  return { ...rollup, range };
}

/**
 * Public entry point for the multi-location roll-up page. Resolves the operator
 * from the session and runs every read through the RLS client.
 */
export async function getLocationRollUp(
  rawFrom?: string,
  rawTo?: string,
): Promise<LocationRollUpReport> {
  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();
  const { range, start, endExclusive } = resolveRange(rawFrom, rawTo);
  return buildLocationRollUp(db, operatorId, start, endExclusive, range);
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export interface ReportsBundle {
  /** Operator brand color (hex) — keeps charts white-label. */
  brandColor: string;
  range: DateRange;
  /** Active date basis (order vs appointment) applied to the Sales report. */
  basis: DateBasis;
  /** Whether comparison-vs-prior-period mode is on. */
  compare: boolean;
  revenue: RevenueReport;
  sales: SalesReport;
  taxesFees: TaxesFeesReport;
  occupancy: OccupancyReport;
  giftCards: GiftCardReport;
}

/**
 * Load all three reports for the resolved range in one tenant-scoped pass. The
 * page renders one at a time (tabbed), but loading all three together keeps the
 * page snappy when switching tabs and lets the CSV export cover any of them
 * without a refetch. Resolves the operator from the session, then runs every
 * read through the RLS client.
 */
export async function getReportsBundle(
  rawFrom?: string,
  rawTo?: string,
  rawBasis?: string,
  rawCompare?: string,
): Promise<ReportsBundle> {
  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();
  const { range, start, endExclusive } = resolveRange(rawFrom, rawTo);
  const basis = resolveDateBasis(rawBasis);
  const compare = rawCompare === '1' || rawCompare === 'true';

  const [operator, revenue, sales, taxesFees, occupancy, giftCards] = await Promise.all([
    db.operator.findUnique({
      where: { id: operatorId },
      select: { brand_color: true },
    }),
    buildRevenueReport(db, operatorId, start, endExclusive, range),
    buildSalesReport(db, operatorId, start, endExclusive, range, basis, compare),
    buildTaxesFeesReport(db, operatorId, start, endExclusive, range),
    buildOccupancyReport(db, operatorId, start, endExclusive, range),
    buildGiftCardReport(db, operatorId, start, endExclusive, range),
  ]);

  return {
    brandColor: operator?.brand_color || '#0ea5e9',
    range,
    basis,
    compare,
    revenue,
    sales,
    taxesFees,
    occupancy,
    giftCards,
  };
}
