// @marina/core — reporting math (pure, DB-free).
//
// These helpers back the admin Reports UI but live here so they can be unit
// tested in isolation (no Prisma, no session) and reused across the admin data
// layer, CSV builders, and any future API report endpoints. Every function is
// pure: given the same inputs it returns the same output. All money is integer
// cents (the app-wide convention).

/**
 * Which date a report attributes a row to.
 *   - `order`: when the transaction was made (Order.created_at). The default,
 *     and what the dashboard/revenue report has always used.
 *   - `appointment`: when the activity actually runs (Timeslot.datetime). The
 *     "slot/appointment date" basis the incumbent calls out.
 */
export type DateBasis = 'order' | 'appointment';

export const DATE_BASES: DateBasis[] = ['order', 'appointment'];

/** Validate/normalize an arbitrary string into a known date basis (defaults to order). */
export function resolveDateBasis(raw?: string): DateBasis {
  return (DATE_BASES as string[]).includes(raw ?? '') ? (raw as DateBasis) : 'order';
}

/** Human label for a date basis (toggles, CSV headers). */
export const DATE_BASIS_LABEL: Record<DateBasis, string> = {
  order: 'Order date',
  appointment: 'Appointment date',
};

// ---------------------------------------------------------------------------
// Comparison math
// ---------------------------------------------------------------------------

/** A current-vs-prior comparison of one integer metric. */
export interface Delta {
  current: number;
  previous: number;
  /** current − previous (can be negative). */
  absolute: number;
  /**
   * Fractional change vs the previous period (0.25 = +25%). `null` when the
   * previous value is 0 (percent change is undefined against a zero base — the
   * UI shows "new" rather than a bogus ∞%).
   */
  ratio: number | null;
  /** Direction of change, for arrow/color decisions. */
  direction: 'up' | 'down' | 'flat';
}

/**
 * Compare a current period value against a prior one. Works for money (cents),
 * counts, or any additive integer metric. Safe against a zero previous base
 * (ratio becomes null, never Infinity/NaN).
 */
export function computeDelta(current: number, previous: number): Delta {
  const absolute = current - previous;
  const ratio = previous === 0 ? null : absolute / previous;
  const direction: Delta['direction'] = absolute > 0 ? 'up' : absolute < 0 ? 'down' : 'flat';
  return { current, previous, absolute, ratio, direction };
}

/**
 * Given a half-open window `[start, endExclusive)`, return the immediately
 * preceding window of the SAME length. Used for "vs previous period" comparison
 * when the user hasn't picked an explicit comparison range. Pure date math — no
 * timezone surprises because it operates on epoch millis of the passed Dates.
 */
export function previousPeriod(start: Date, endExclusive: Date): {
  start: Date;
  endExclusive: Date;
} {
  const spanMs = endExclusive.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime());
  const prevStart = new Date(start.getTime() - spanMs);
  return { start: prevStart, endExclusive: prevEnd };
}

// ---------------------------------------------------------------------------
// Payments-by-method summary
// ---------------------------------------------------------------------------

/** The payment methods we break out (mirrors the Prisma PaymentMethod enum). */
export type PaymentMethodKey = 'CARD' | 'CASH' | 'GIFT_CARD' | 'COMP';

export const PAYMENT_METHOD_KEYS: PaymentMethodKey[] = ['CARD', 'CASH', 'GIFT_CARD', 'COMP'];

export const PAYMENT_METHOD_LABEL: Record<PaymentMethodKey, string> = {
  CARD: 'Card',
  CASH: 'Cash',
  GIFT_CARD: 'Gift card',
  COMP: 'Comp',
};

/** A minimal payment row: everything the summary needs, nothing tenant-specific. */
export interface PaymentRow {
  method: string;
  amount_cents: number;
  refunded_cents: number;
}

/** Collected/refunded/net totals for one payment method. */
export interface PaymentMethodTotal {
  method: PaymentMethodKey;
  collectedCents: number;
  refundedCents: number;
  /** collected − refunded. */
  netCents: number;
  count: number;
}

export interface PaymentsSummary {
  byMethod: PaymentMethodTotal[];
  totals: {
    collectedCents: number;
    refundedCents: number;
    netCents: number;
    count: number;
  };
}

/**
 * Roll a set of payment rows up by method. Always returns a row for every known
 * method (zero-filled), in a stable order, so the UI/CSV render a complete,
 * predictable table even for a quiet period. An unrecognized method string is
 * bucketed under COMP defensively (never dropped, never throws).
 */
export function summarizePayments(rows: readonly PaymentRow[]): PaymentsSummary {
  const buckets = new Map<PaymentMethodKey, PaymentMethodTotal>();
  for (const key of PAYMENT_METHOD_KEYS) {
    buckets.set(key, {
      method: key,
      collectedCents: 0,
      refundedCents: 0,
      netCents: 0,
      count: 0,
    });
  }

  for (const row of rows) {
    const key: PaymentMethodKey = (PAYMENT_METHOD_KEYS as string[]).includes(row.method)
      ? (row.method as PaymentMethodKey)
      : 'COMP';
    const bucket = buckets.get(key)!;
    bucket.collectedCents += row.amount_cents;
    bucket.refundedCents += row.refunded_cents;
    bucket.count += 1;
  }

  const byMethod = PAYMENT_METHOD_KEYS.map((key) => {
    const b = buckets.get(key)!;
    b.netCents = b.collectedCents - b.refundedCents;
    return b;
  });

  const totals = byMethod.reduce(
    (acc, b) => {
      acc.collectedCents += b.collectedCents;
      acc.refundedCents += b.refundedCents;
      acc.netCents += b.netCents;
      acc.count += b.count;
      return acc;
    },
    { collectedCents: 0, refundedCents: 0, netCents: 0, count: 0 },
  );

  return { byMethod, totals };
}

// ---------------------------------------------------------------------------
// Multi-location roll-up (Upmarket §1 #6-B)
// ---------------------------------------------------------------------------

/** One row of raw per-location metrics, pre-aggregation. */
export interface LocationMetricRow {
  /** Location id, or null for activities with no location assigned. */
  locationId: string | null;
  locationName: string;
  /** Recognized gross revenue for this location, integer cents. */
  grossCents: number;
  /** Number of orders attributed to this location. */
  orders: number;
  /** Seats booked across this location's timeslots. */
  capacityBooked: number;
  /** Seat capacity across this location's timeslots. */
  capacityTotal: number;
}

/** A location's aggregated roll-up, with occupancy derived. */
export interface LocationRollUpRow extends LocationMetricRow {
  /** capacityBooked / capacityTotal in 0..1 (0 when no capacity). */
  occupancy: number;
  /** This location's share of combined gross revenue in 0..1 (0 when none). */
  revenueShare: number;
}

export interface LocationRollUp {
  rows: LocationRollUpRow[];
  totals: {
    grossCents: number;
    orders: number;
    capacityBooked: number;
    capacityTotal: number;
    occupancy: number;
    /** Number of locations with any activity (rows.length). */
    locations: number;
  };
}

/**
 * Combine per-location metric rows into a cross-location roll-up: derives each
 * location's occupancy and revenue share, plus combined totals. Rows sharing a
 * locationId are merged (defensive), and the result is sorted by gross revenue
 * descending. Pure and DB-free so it unit-tests in isolation and can back both the
 * admin dashboard and a CSV export. All money is integer cents.
 */
export function rollUpByLocation(rows: readonly LocationMetricRow[]): LocationRollUp {
  const merged = new Map<string, LocationMetricRow>();
  for (const r of rows) {
    const key = r.locationId ?? '__none__';
    const existing = merged.get(key);
    if (existing) {
      existing.grossCents += r.grossCents;
      existing.orders += r.orders;
      existing.capacityBooked += r.capacityBooked;
      existing.capacityTotal += r.capacityTotal;
    } else {
      merged.set(key, { ...r });
    }
  }

  const totals = {
    grossCents: 0,
    orders: 0,
    capacityBooked: 0,
    capacityTotal: 0,
    occupancy: 0,
    locations: merged.size,
  };
  for (const r of merged.values()) {
    totals.grossCents += r.grossCents;
    totals.orders += r.orders;
    totals.capacityBooked += r.capacityBooked;
    totals.capacityTotal += r.capacityTotal;
  }
  totals.occupancy = totals.capacityTotal ? totals.capacityBooked / totals.capacityTotal : 0;

  const rollupRows: LocationRollUpRow[] = Array.from(merged.values())
    .map((r) => ({
      ...r,
      occupancy: r.capacityTotal ? r.capacityBooked / r.capacityTotal : 0,
      revenueShare: totals.grossCents ? r.grossCents / totals.grossCents : 0,
    }))
    .sort((a, b) => b.grossCents - a.grossCents);

  return { rows: rollupRows, totals };
}

// ---------------------------------------------------------------------------
// Refunds-by-reason report
// ---------------------------------------------------------------------------

/**
 * Canonical "no reason given" bucket key. A refund OrderEvent whose metadata
 * has a null/blank/missing reason lands here rather than being dropped — a
 * reasonless refund is itself a signal worth surfacing.
 */
export const REFUND_REASON_NONE = 'No reason given';

/**
 * A minimal refund row, derived from a REFUND OrderEvent's metadata. Pure and
 * DB-free so the aggregation unit-tests in isolation and is reused across the
 * admin data layer and CSV export. All money is integer cents.
 */
export interface RefundRow {
  /** Free-text reason from event metadata (null/blank → bucketed as "No reason given"). */
  reason: string | null | undefined;
  /** Refunded amount, integer cents. */
  amountCents: number;
  /** Activity id this refund is attributed to, or null when none. */
  activityId: string | null;
  /** Activity display name (used for the by-activity breakdown). */
  activityName: string;
}

/** One reason bucket: total refunded + how many refunds carried that reason. */
export interface RefundReasonTotal {
  reason: string;
  amountCents: number;
  count: number;
}

/** One activity bucket: total refunded + refund count for that activity. */
export interface RefundActivityTotal {
  activityId: string | null;
  activityName: string;
  amountCents: number;
  count: number;
}

export interface RefundsReport {
  byReason: RefundReasonTotal[];
  byActivity: RefundActivityTotal[];
  totals: {
    amountCents: number;
    count: number;
  };
}

/** Normalize a raw reason into a stable bucket key (blank/missing → the NONE bucket). */
function refundReasonKey(reason: string | null | undefined): string {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  return trimmed.length > 0 ? trimmed : REFUND_REASON_NONE;
}

/**
 * Aggregate refund rows into a by-reason and by-activity breakdown plus grand
 * totals. Pure and DB-free. Reasons and activities are each merged into stable
 * buckets, both lists sorted by refunded amount descending (ties broken by name
 * / reason for determinism). The NONE bucket ("No reason given") is always kept
 * when present rather than silently dropped. All money is integer cents.
 */
export function aggregateRefunds(rows: readonly RefundRow[]): RefundsReport {
  const reasons = new Map<string, RefundReasonTotal>();
  const activities = new Map<string, RefundActivityTotal>();
  let totalCents = 0;
  let totalCount = 0;

  for (const row of rows) {
    totalCents += row.amountCents;
    totalCount += 1;

    const rKey = refundReasonKey(row.reason);
    const rBucket = reasons.get(rKey);
    if (rBucket) {
      rBucket.amountCents += row.amountCents;
      rBucket.count += 1;
    } else {
      reasons.set(rKey, { reason: rKey, amountCents: row.amountCents, count: 1 });
    }

    const aKey = row.activityId ?? '__none__';
    const aBucket = activities.get(aKey);
    if (aBucket) {
      aBucket.amountCents += row.amountCents;
      aBucket.count += 1;
    } else {
      activities.set(aKey, {
        activityId: row.activityId ?? null,
        activityName: row.activityName,
        amountCents: row.amountCents,
        count: 1,
      });
    }
  }

  const byReason = Array.from(reasons.values()).sort(
    (a, b) => b.amountCents - a.amountCents || a.reason.localeCompare(b.reason),
  );
  const byActivity = Array.from(activities.values()).sort(
    (a, b) => b.amountCents - a.amountCents || a.activityName.localeCompare(b.activityName),
  );

  return {
    byReason,
    byActivity,
    totals: { amountCents: totalCents, count: totalCount },
  };
}
