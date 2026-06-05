/**
 * Resource-backed availability — the moat for complex multi-asset operators.
 *
 * A `Resource` (a boat, jet ski, kayak, patio) is a finite pool of physical units that
 * may back MORE THAN ONE activity (the `ActivityResources` m2m). A 10-person pontoon
 * that backs both the "2-hour rental" and the "sunset cruise" can only be in one place
 * at one time: booking it for the cruise must remove that capacity from the rental for
 * any overlapping time. Per-timeslot `capacity_total` alone cannot express this — it is
 * scoped to a single activity and is blind to siblings sharing the same asset.
 *
 * The seat pool a resource provides at any instant is
 *   poolTotal = seat_capacity × (quantity − out_of_service_qty)
 * and a booking of N participants draws N seats from it. An activity backed by several
 * resources is bound by the scarcest (the min remaining across them). An activity backed
 * by NO active resource is unconstrained here (`remaining: null`) — only its timeslot's
 * own capacity applies, exactly as before.
 *
 * How long a booking holds the asset is the **Rate**'s `duration_minutes` (the schema's
 * source of truth — a "2-hour rental" and a "4-hour rental" are two rates on one
 * activity). A booking occupies [slot.datetime, slot.datetime + rate.duration). Two
 * bookings contend for the pool iff their intervals overlap
 * ([a,b) overlaps [c,d) ⇔ a < d ∧ b > c). Contention is therefore measured at the
 * OrderItem level — each item carries its own slot start and its own rate duration — not
 * from aggregated per-timeslot capacity, which can't see mixed-duration bookings.
 *
 * Whole-unit / exclusive-charter allocation (a booking reserves a whole unit regardless
 * of party size) is a future per-resource policy; this models shared seating, which uses
 * every field already on `Resource`.
 */

/**
 * The exact model reads this service needs, typed structurally so BOTH a transaction
 * client (`Prisma.TransactionClient`, the booking write-guard) and a `TenantClient`
 * (the availability read) satisfy it without fighting Prisma's extended-client generics.
 * Args are passed through to the underlying delegate; only the selected result shape is
 * pinned here (what this service actually consumes).
 */
interface ResourceClient {
  // `any` here is deliberate: Prisma's delegate methods are generic, and pinning either
  // the args or the (narrowed) return breaks structural assignability of the real
  // clients to this interface. The result shapes are re-pinned with local annotations at
  // each call site below, so everything this service consumes stays strongly typed.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  resource: { findMany(args: any): Promise<any> };
  rate: { aggregate(args: any): Promise<any> };
  orderItem: { findMany(args: any): Promise<any> };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Locally-pinned shapes of exactly what this service selects. */
interface ResourceRow {
  name: string;
  seat_capacity: number;
  quantity: number;
  out_of_service_qty: number;
  activities: Array<{ id: string }>;
}
interface OccupyingItem {
  activity_id: string;
  quantity: number;
  timeslot: { datetime: Date } | null;
  rate: { duration_minutes: number } | null;
}

export interface ResourceConstraint {
  /**
   * Additional units sellable at the slot given the shared resource pool, or `null`
   * when no active resource backs the activity (⇒ no resource constraint at all).
   * Already accounts for the candidate slot's own existing bookings.
   */
  remaining: number | null;
  /** Name of the scarcest (binding) resource, for user-facing messages. */
  bindingResourceName: string | null;
}

const NO_CONSTRAINT: ResourceConstraint = { remaining: null, bindingResourceName: null };

/** [aStart, aEnd) overlaps [bStart, bEnd). */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * Resource constraint for a SET of the activity's timeslots at once — the efficient
 * primitive (one resource query, one max-duration probe, one overlapping-item query for
 * the whole set). Returns a map keyed by the slot id you pass in.
 *
 * @param candidateDurationMs how long the booking being evaluated holds the asset — the
 *   chosen rate's duration on the write path, or the activity's longest rate on a
 *   rate-agnostic availability read.
 */
export async function getResourceConstraints(
  db: ResourceClient,
  activityId: string,
  slots: Array<{ id: string; datetime: Date }>,
  candidateDurationMs: number,
): Promise<Map<string, ResourceConstraint>> {
  const result = new Map<string, ResourceConstraint>();
  if (slots.length === 0) return result;

  // Active resources backing this activity, each with the activities it backs (the
  // sibling set that draws from the same pool).
  const resources: ResourceRow[] = await db.resource.findMany({
    where: { is_active: true, activities: { some: { id: activityId } } },
    select: {
      name: true,
      seat_capacity: true,
      quantity: true,
      out_of_service_qty: true,
      activities: { select: { id: true } },
    },
  });
  if (resources.length === 0) {
    for (const s of slots) result.set(s.id, NO_CONSTRAINT);
    return result;
  }

  const siblingIds = [...new Set(resources.flatMap((r) => r.activities.map((a) => a.id)))];

  // Size the coarse fetch window from the longest rate any sibling activity offers, so
  // no overlapping occurrence is missed (then we overlap-filter precisely below).
  const agg: { _max: { duration_minutes: number | null } } = await db.rate.aggregate({
    where: { activity_id: { in: siblingIds } },
    _max: { duration_minutes: true },
  });
  const maxRateDurMs = (agg._max.duration_minutes ?? 0) * 60_000;

  const candStarts = slots.map((s) => s.datetime.getTime());
  const windowLo = new Date(Math.min(...candStarts) - maxRateDurMs);
  const windowHi = new Date(Math.max(...candStarts) + candidateDurationMs);

  // Every booked, non-cancelled item on a sibling activity whose slot falls in the coarse
  // window. Each carries its own start (timeslot) and duration (rate) for exact overlap.
  const items: OccupyingItem[] = await db.orderItem.findMany({
    where: {
      activity_id: { in: siblingIds },
      status: { not: 'CANCELLED' },
      timeslot: { datetime: { gte: windowLo, lt: windowHi } },
    },
    select: {
      activity_id: true,
      quantity: true,
      timeslot: { select: { datetime: true } },
      rate: { select: { duration_minutes: true } },
    },
  });

  const resourceMembers = resources.map((r) => ({
    name: r.name,
    poolTotal: r.seat_capacity * Math.max(0, r.quantity - r.out_of_service_qty),
    members: new Set(r.activities.map((a) => a.id)),
  }));

  for (const slot of slots) {
    const candStart = slot.datetime.getTime();
    const candEnd = candStart + candidateDurationMs;

    const overlapping = items.filter((it) => {
      if (!it.timeslot || !it.rate) return false;
      const iStart = it.timeslot.datetime.getTime();
      const iEnd = iStart + it.rate.duration_minutes * 60_000;
      return overlaps(candStart, candEnd, iStart, iEnd);
    });

    let minRemaining = Infinity;
    let bindingResourceName: string | null = null;
    for (const r of resourceMembers) {
      let used = 0;
      for (const it of overlapping) {
        if (r.members.has(it.activity_id)) used += it.quantity;
      }
      const remaining = r.poolTotal - used;
      if (remaining < minRemaining) {
        minRemaining = remaining;
        bindingResourceName = r.name;
      }
    }

    result.set(slot.id, { remaining: Math.max(0, minRemaining), bindingResourceName });
  }

  return result;
}

/**
 * Resource constraint for a SINGLE timeslot occurrence (the booking-guard path). Thin
 * wrapper over {@link getResourceConstraints}.
 */
export async function getResourceConstraint(
  db: ResourceClient,
  params: { activityId: string; slotStart: Date; durationMs: number },
): Promise<ResourceConstraint> {
  const m = await getResourceConstraints(
    db,
    params.activityId,
    [{ id: '_', datetime: params.slotStart }],
    params.durationMs,
  );
  return m.get('_') ?? NO_CONSTRAINT;
}
