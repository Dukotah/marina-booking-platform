import 'server-only';
import { getOperatorContext, getTenantDb } from '../../lib/session';

/**
 * Dashboard data layer.
 *
 * Every read here goes through the tenant-scoped client (`getTenantDb`), so RLS
 * scopes results to the current operator. We still write explicit, correct
 * where-clauses (defense in depth — never rely on RLS alone for correctness).
 *
 * All money is integer cents. Times are stored UTC; rendering uses the admin
 * format helpers. Date-window math here uses the server clock — good enough for
 * KPI windows; per-operator-timezone bucketing is a later refinement.
 *
 * Everything degrades gracefully with no seed data: counts come back 0, the
 * trend series is a flat run of zero-revenue days, and lists come back empty.
 */

/** Number of trailing days (including today) shown in the revenue trend chart. */
const TREND_DAYS = 14;
/** How many upcoming bookings to surface in the feed. */
const UPCOMING_LIMIT = 8;
/** Capacity ratio at/above which a timeslot is flagged "low capacity" in alerts. */
const LOW_CAPACITY_THRESHOLD = 0.85;
/** How many alerts of each kind to surface. */
const ALERTS_LIMIT = 6;

/** Statuses that represent live revenue (exclude cancelled / no-show). */
const REVENUE_STATUSES = ['UPCOMING', 'COMPLETED'] as const;

/** Start of the local day for the given date (00:00:00.000). */
function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Start of the week (Monday) containing the given date. */
function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const day = x.getDay(); // 0 = Sun … 6 = Sat
  const diff = (day + 6) % 7; // days since Monday
  x.setDate(x.getDate() - diff);
  return x;
}

/** Start of the month containing the given date. */
function startOfMonth(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}

/** Add `n` days to a copy of `d`. */
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export interface RevenuePoint {
  /** ISO date (YYYY-MM-DD) for the bucket. */
  date: string;
  /** Total live revenue booked that day, in integer cents. */
  cents: number;
}

export interface UpcomingBooking {
  id: string;
  orderNumber: string;
  customerName: string;
  activityName: string;
  datetime: Date;
  quantity: number;
  totalCents: number;
  waiverSigned: boolean;
}

export interface DashboardAlert {
  id: string;
  kind: 'UNSIGNED_WAIVER' | 'LOW_CAPACITY';
  title: string;
  detail: string;
  /** When the underlying thing happens (booking time / slot time), for sorting. */
  at: Date;
}

export interface OccupancySlice {
  activityId: string;
  activityName: string;
  color: string;
  capacityTotal: number;
  capacityBooked: number;
}

export interface DashboardData {
  revenue: {
    todayCents: number;
    weekCents: number;
    monthCents: number;
  };
  /** Booked vs total capacity across today's (non-cancelled) timeslots. */
  occupancy: {
    capacityTotal: number;
    capacityBooked: number;
    ratio: number; // 0–1
    slices: OccupancySlice[];
  };
  upcomingCount: number;
  trend: RevenuePoint[];
  upcoming: UpcomingBooking[];
  alerts: DashboardAlert[];
  /**
   * True when live data could not be loaded (e.g. the database is unreachable or
   * env vars are not configured on this deployment). The page renders an empty,
   * zeroed dashboard plus a notice rather than throwing a 500.
   */
  degraded: boolean;
}

/** A zeroed dashboard with a flat 14-day trend, used when the DB is unreachable. */
function emptyDashboard(now: Date, degraded: boolean): DashboardData {
  const todayStart = startOfDay(now);
  const trend: RevenuePoint[] = Array.from({ length: TREND_DAYS }, (_, i) => {
    const d = addDays(todayStart, i - (TREND_DAYS - 1));
    return { date: d.toISOString().slice(0, 10), cents: 0 };
  });
  return {
    revenue: { todayCents: 0, weekCents: 0, monthCents: 0 },
    occupancy: { capacityTotal: 0, capacityBooked: 0, ratio: 0, slices: [] },
    upcomingCount: 0,
    trend,
    upcoming: [],
    alerts: [],
    degraded,
  };
}

/**
 * Sum live order revenue created within [from, to).
 *
 * Revenue is attributed by `created_at` (when the booking transaction was made),
 * which is what an operator means by "revenue today". Cancelled / no-show orders
 * are excluded.
 */
async function sumRevenue(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  operatorId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const agg = await db.order.aggregate({
    _sum: { total_cents: true },
    where: {
      operator_id: operatorId,
      status: { in: [...REVENUE_STATUSES] },
      created_at: { gte: from, lt: to },
    },
  });
  return agg._sum.total_cents ?? 0;
}

/** Build the trailing-`TREND_DAYS` revenue series (oldest → newest, zero-filled). */
async function buildTrend(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  operatorId: string,
  now: Date,
): Promise<RevenuePoint[]> {
  const today = startOfDay(now);
  const windowStart = addDays(today, -(TREND_DAYS - 1));
  const windowEnd = addDays(today, 1); // exclusive end = start of tomorrow

  const orders = await db.order.findMany({
    where: {
      operator_id: operatorId,
      status: { in: [...REVENUE_STATUSES] },
      created_at: { gte: windowStart, lt: windowEnd },
    },
    select: { created_at: true, total_cents: true },
  });

  // Bucket by local ISO date.
  const buckets = new Map<string, number>();
  for (let i = 0; i < TREND_DAYS; i++) {
    buckets.set(isoDate(addDays(windowStart, i)), 0);
  }
  for (const o of orders) {
    const key = isoDate(startOfDay(o.created_at));
    buckets.set(key, (buckets.get(key) ?? 0) + o.total_cents);
  }

  return Array.from(buckets.entries()).map(([date, cents]) => ({ date, cents }));
}

/** Local ISO date string (YYYY-MM-DD) without UTC shift. */
function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today's occupancy across non-cancelled timeslots, rolled up per activity. */
async function buildOccupancy(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  operatorId: string,
  now: Date,
): Promise<DashboardData['occupancy']> {
  const dayStart = startOfDay(now);
  const dayEnd = addDays(dayStart, 1);

  const slots = await db.timeslot.findMany({
    where: {
      operator_id: operatorId,
      status: { not: 'CANCELLED' },
      datetime: { gte: dayStart, lt: dayEnd },
    },
    select: {
      capacity_total: true,
      capacity_booked: true,
      activity: { select: { id: true, name_external: true, color: true } },
    },
  });

  const byActivity = new Map<string, OccupancySlice>();
  let capacityTotal = 0;
  let capacityBooked = 0;

  for (const s of slots) {
    capacityTotal += s.capacity_total;
    capacityBooked += s.capacity_booked;
    const a = s.activity;
    const existing = byActivity.get(a.id);
    if (existing) {
      existing.capacityTotal += s.capacity_total;
      existing.capacityBooked += s.capacity_booked;
    } else {
      byActivity.set(a.id, {
        activityId: a.id,
        activityName: a.name_external,
        color: a.color,
        capacityTotal: s.capacity_total,
        capacityBooked: s.capacity_booked,
      });
    }
  }

  const slices = Array.from(byActivity.values()).sort((x, y) => {
    const rx = x.capacityTotal ? x.capacityBooked / x.capacityTotal : 0;
    const ry = y.capacityTotal ? y.capacityBooked / y.capacityTotal : 0;
    return ry - rx;
  });

  return {
    capacityTotal,
    capacityBooked,
    ratio: capacityTotal ? capacityBooked / capacityTotal : 0,
    slices,
  };
}

/** The next `UPCOMING_LIMIT` bookings (order items) from now forward. */
async function buildUpcoming(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  operatorId: string,
  now: Date,
): Promise<UpcomingBooking[]> {
  const items = await db.orderItem.findMany({
    where: {
      operator_id: operatorId,
      status: 'UPCOMING',
      timeslot: { datetime: { gte: now } },
    },
    orderBy: { timeslot: { datetime: 'asc' } },
    take: UPCOMING_LIMIT,
    select: {
      id: true,
      quantity: true,
      waiver_signed: true,
      activity: { select: { name_external: true } },
      timeslot: { select: { datetime: true } },
      order: {
        select: {
          order_number: true,
          total_cents: true,
          customer: { select: { first_name: true, last_name: true } },
        },
      },
    },
  });

  return items.map((it) => ({
    id: it.id,
    orderNumber: it.order.order_number,
    customerName: fullName(it.order.customer.first_name, it.order.customer.last_name),
    activityName: it.activity.name_external,
    datetime: it.timeslot.datetime,
    quantity: it.quantity,
    totalCents: it.order.total_cents,
    waiverSigned: it.waiver_signed,
  }));
}

function fullName(first: string, last: string): string {
  return `${first} ${last}`.trim() || 'Guest';
}

/**
 * Operational alerts the operator should act on:
 *  - unsigned waivers on imminent upcoming bookings, and
 *  - timeslots running low on capacity today/soon.
 */
async function buildAlerts(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  operatorId: string,
  now: Date,
): Promise<DashboardAlert[]> {
  const horizon = addDays(startOfDay(now), 7); // look a week ahead

  const [unsigned, lowSlots] = await Promise.all([
    db.orderItem.findMany({
      where: {
        operator_id: operatorId,
        status: 'UPCOMING',
        waiver_signed: false,
        activity: { waiver_required: true },
        timeslot: { datetime: { gte: now, lt: horizon } },
      },
      orderBy: { timeslot: { datetime: 'asc' } },
      take: ALERTS_LIMIT,
      select: {
        id: true,
        activity: { select: { name_external: true } },
        timeslot: { select: { datetime: true } },
        order: {
          select: {
            order_number: true,
            customer: { select: { first_name: true, last_name: true } },
          },
        },
      },
    }),
    db.timeslot.findMany({
      where: {
        operator_id: operatorId,
        status: { not: 'CANCELLED' },
        datetime: { gte: now, lt: horizon },
        capacity_total: { gt: 0 },
      },
      orderBy: { datetime: 'asc' },
      select: {
        id: true,
        datetime: true,
        capacity_total: true,
        capacity_booked: true,
        activity: { select: { name_external: true } },
      },
    }),
  ]);

  const waiverAlerts: DashboardAlert[] = unsigned.map((it) => ({
    id: `waiver-${it.id}`,
    kind: 'UNSIGNED_WAIVER',
    title: 'Unsigned waiver',
    detail: `${fullName(
      it.order.customer.first_name,
      it.order.customer.last_name,
    )} · ${it.activity.name_external} · ${it.order.order_number}`,
    at: it.timeslot.datetime,
  }));

  const capacityAlerts: DashboardAlert[] = lowSlots
    .filter((s) => s.capacity_booked / s.capacity_total >= LOW_CAPACITY_THRESHOLD)
    .slice(0, ALERTS_LIMIT)
    .map((s) => {
      const remaining = Math.max(0, s.capacity_total - s.capacity_booked);
      const full = remaining === 0;
      return {
        id: `capacity-${s.id}`,
        kind: 'LOW_CAPACITY',
        title: full ? 'Slot full' : 'Low capacity',
        detail: full
          ? `${s.activity.name_external} · sold out`
          : `${s.activity.name_external} · ${remaining} seat${remaining === 1 ? '' : 's'} left`,
        at: s.datetime,
      };
    });

  return [...waiverAlerts, ...capacityAlerts]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, ALERTS_LIMIT * 2);
}

/**
 * Load everything the dashboard needs in one tenant-scoped pass. Resolves the
 * operator from the session, then runs all reads through the RLS client.
 */
export async function getDashboardData(): Promise<DashboardData> {
  const now = new Date();
  try {
    const { operatorId } = await getOperatorContext();
    const db = await getTenantDb();

    const todayStart = startOfDay(now);
    const tomorrowStart = addDays(todayStart, 1);
    const weekStart = startOfWeek(now);
    const monthStart = startOfMonth(now);

    const [
      todayCents,
      weekCents,
      monthCents,
      upcomingCount,
      occupancy,
      trend,
      upcoming,
      alerts,
    ] = await Promise.all([
      sumRevenue(db, operatorId, todayStart, tomorrowStart),
      sumRevenue(db, operatorId, weekStart, tomorrowStart),
      sumRevenue(db, operatorId, monthStart, tomorrowStart),
      db.orderItem.count({
        where: {
          operator_id: operatorId,
          status: 'UPCOMING',
          timeslot: { datetime: { gte: now } },
        },
      }),
      buildOccupancy(db, operatorId, now),
      buildTrend(db, operatorId, now),
      buildUpcoming(db, operatorId, now),
      buildAlerts(db, operatorId, now),
    ]);

    return {
      revenue: { todayCents, weekCents, monthCents },
      occupancy,
      upcomingCount,
      trend,
      upcoming,
      alerts,
      degraded: false,
    };
  } catch (err) {
    // The admin app talks to the DB directly (D-007); if it's unreachable (missing
    // env vars on this deployment, network blip, etc.) render an empty dashboard
    // with a notice instead of throwing a 500. See lib/session for the connection.
    console.error('[dashboard] failed to load live data — rendering degraded:', err);
    return emptyDashboard(now, true);
  }
}
