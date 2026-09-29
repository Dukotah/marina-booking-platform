import { getOperatorContext, getTenantDb } from '../../lib/session';
import { localDayRangeUtc, localMinutesOfDay, todayIsoIn } from '../../components/manifest/tz';
import type {
  ManifestBooking,
  ManifestGuide,
  ManifestRow,
  ManifestSlot,
} from '../../components/manifest/types';

/**
 * Load the Gantt manifest view-model for a single operator-local day.
 *
 * Strategy: pull every active activity that has at least one timeslot within the
 * local day window, plus those timeslots' order items (the bookings). We group into
 * one row per activity, derive each booking's start/end minutes in the operator
 * timezone, and aggregate capacity. All reads go through the tenant-scoped client so
 * RLS guarantees single-operator data even though we also scope by operator_id.
 */
export interface ManifestData {
  timeZone: string;
  rows: ManifestRow[];
  totalBookings: number;
  checkedIn: number;
  /** Sum of capacity_total across the day's slots (utilization denominator). */
  capacityTotal: number;
  /** Sum of capacity_booked across the day's slots (utilization numerator). */
  capacityBooked: number;
}

export async function loadManifest(isoDate: string): Promise<ManifestData> {
  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();

  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { timezone: true },
  });
  const timeZone = operator?.timezone ?? 'America/Los_Angeles';

  const { startUtc, endUtc } = localDayRangeUtc(isoDate, timeZone);

  // Activities that have timeslots in the window, with the slots + their bookings.
  const activities = await db.activity.findMany({
    where: {
      operator_id: operatorId,
      status: 'ACTIVE',
      timeslots: { some: { datetime: { gte: startUtc, lt: endUtc } } },
    },
    select: {
      id: true,
      name_internal: true,
      name_external: true,
      color: true,
      sort_index: true,
      timeslots: {
        where: { datetime: { gte: startUtc, lt: endUtc }, status: { not: 'CANCELLED' } },
        select: {
          id: true,
          datetime: true,
          capacity_total: true,
          capacity_booked: true,
          guide_assignments: {
            select: {
              id: true,
              guide_id: true,
              role_label: true,
              guide: { select: { name: true, email: true } },
            },
            orderBy: { created_at: 'asc' },
          },
          // Cancelled items ARE loaded (the list view can reveal them behind a
          // toggle); every count below still excludes them, and the other views
          // filter them out, so nothing else changes.
          order_items: {
            select: {
              id: true,
              quantity: true,
              status: true,
              waiver_signed: true,
              rate: { select: { name_external: true, name_internal: true, duration_minutes: true } },
              order: {
                select: {
                  id: true,
                  order_number: true,
                  balance_due_cents: true,
                  customer: { select: { first_name: true, last_name: true, phone: true } },
                },
              },
            },
          },
        },
      },
    },
    orderBy: [{ sort_index: 'asc' }, { name_internal: 'asc' }],
  });

  let totalBookings = 0;
  let checkedIn = 0;
  let capacityTotalAll = 0;
  let capacityBookedAll = 0;

  const rows: ManifestRow[] = activities.map((activity) => {
    let capacityTotal = 0;
    let capacityBooked = 0;
    const bookings: ManifestBooking[] = [];
    const slots: ManifestSlot[] = [];
    // De-dup guides across the activity's slots for the row-level chip list.
    const guideById = new Map<string, ManifestGuide>();

    for (const slot of activity.timeslots) {
      capacityTotal += slot.capacity_total;
      capacityBooked += slot.capacity_booked;

      const startMin = localMinutesOfDay(slot.datetime, timeZone);

      const slotGuides: ManifestGuide[] = slot.guide_assignments.map((g) => {
        const view: ManifestGuide = {
          assignmentId: g.id,
          guideId: g.guide_id,
          guideName: g.guide.name,
          guideEmail: g.guide.email,
          roleLabel: g.role_label,
        };
        if (!guideById.has(g.guide_id)) guideById.set(g.guide_id, view);
        return view;
      });

      slots.push({
        timeslotId: slot.id,
        startISO: slot.datetime.toISOString(),
        startMin,
        capacityTotal: slot.capacity_total,
        capacityBooked: slot.capacity_booked,
        guides: slotGuides,
      });
      for (const item of slot.order_items) {
        const durationMin = item.rate?.duration_minutes ?? 240;
        const rawEnd = startMin + durationMin;
        const endMin = Math.min(rawEnd, 24 * 60);
        const endsNextDay = rawEnd > 24 * 60;
        const returnMin = rawEnd % (24 * 60);
        const cust = item.order.customer;
        const customerName = `${cust.first_name} ${cust.last_name}`.trim() || 'Guest';

        bookings.push({
          orderItemId: item.id,
          orderId: item.order.id,
          orderNumber: item.order.order_number,
          timeslotId: slot.id,
          customerName,
          rateName: item.rate?.name_external || item.rate?.name_internal || 'Rate',
          quantity: item.quantity,
          status: item.status,
          startMin,
          endMin,
          returnMin,
          endsNextDay,
          startISO: slot.datetime.toISOString(),
          waiverSigned: item.waiver_signed,
          balanceDueCents: item.order.balance_due_cents,
          customerPhone: item.order.customer.phone ?? null,
        });

        if (item.status !== 'CANCELLED') totalBookings += 1;
        if (item.status === 'CHECKED_IN') checkedIn += 1;
      }
    }

    bookings.sort((a, b) => a.startMin - b.startMin);
    slots.sort((a, b) => a.startMin - b.startMin);
    capacityTotalAll += capacityTotal;
    capacityBookedAll += capacityBooked;

    return {
      activityId: activity.id,
      activityName: activity.name_internal || activity.name_external,
      color: activity.color,
      capacityTotal,
      capacityBooked,
      slots,
      guides: Array.from(guideById.values()),
      bookings,
    };
  });

  return {
    timeZone,
    rows,
    totalBookings,
    checkedIn,
    capacityTotal: capacityTotalAll,
    capacityBooked: capacityBookedAll,
  };
}

// ---------------------------------------------------------------------------
// Fleet — per-boat status (each Activity IS one boat / jet ski / patio here)
// ---------------------------------------------------------------------------

/**
 * The restore payload of one fleet outage, read back from the audit log.
 *
 * The audit log is the system of record for an outage's bookkeeping on purpose:
 * the ENFORCED state lives in BlackoutDate rows (customer availability skips
 * those days) and closed Timeslot rows (the booking engine refuses CANCELLED),
 * and the `fleet.out_of_service` event records exactly which rows those were —
 * `blackout_ids` + `closed_slot_ids` — so "Back in service" can reverse
 * precisely what "Out of service" did and nothing else. See the restore
 * contract on takeBoatOutOfService in ./actions.ts.
 */
export interface FleetOutage {
  activityId: string;
  reason: string;
  /** Operator-local YYYY-MM-DD the boat went out. */
  fromISO: string;
  /** Operator-local YYYY-MM-DD it is expected back; null = open-ended. */
  untilISO: string | null;
  recordedAtISO: string;
  /** BlackoutDate row ids this outage created (deleted on restore). */
  blackoutIds: string[];
  /** Timeslot ids this outage closed (re-opened on restore, where still safe). */
  closedSlotIds: string[];
}

/** Audit ceiling: newest-first, we only need the latest event per activity. */
const FLEET_EVENT_SCAN = 400;

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * The CURRENT outage per activity: the newest fleet event decides. A
 * `fleet.back_in_service` (or nothing) means the boat is on the water; a
 * `fleet.out_of_service` whose window is already fully in the past also counts
 * as back — every day it blacked out and every slot it closed is history, so
 * nothing is enforced anymore and showing it as down would be a lie.
 */
export async function readFleetOutages(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  todayISO: string,
): Promise<Map<string, FleetOutage>> {
  const events = await db.auditLog.findMany({
    where: {
      entity_type: 'Activity',
      action: { in: ['fleet.out_of_service', 'fleet.back_in_service'] },
    },
    orderBy: { created_at: 'desc' },
    select: { entity_id: true, action: true, after: true, created_at: true },
    take: FLEET_EVENT_SCAN,
  });

  const outages = new Map<string, FleetOutage>();
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.entity_id)) continue; // newest-first: first row per boat wins
    seen.add(event.entity_id);
    if (event.action !== 'fleet.out_of_service') continue;
    const after = (event.after ?? {}) as Record<string, unknown>;
    const fromISO = str(after.out_from);
    const untilISO = str(after.expected_back);
    if (!fromISO) continue;
    // Window fully past = effectively back in service (see doc comment above).
    if (untilISO && untilISO < todayISO) continue;
    outages.set(event.entity_id, {
      activityId: event.entity_id,
      reason: str(after.reason) ?? '',
      fromISO,
      untilISO,
      recordedAtISO: event.created_at.toISOString(),
      blackoutIds: idList(after.blackout_ids),
      closedSlotIds: idList(after.closed_slot_ids),
    });
  }
  return outages;
}

/** One boat/patio as the fleet panel needs it. */
export interface FleetBoat {
  id: string;
  name: string;
  category: string;
  color: string;
  /** True when at least one active ScheduleRule is generating departures. */
  hasActiveRule: boolean;
  outage: {
    reason: string;
    fromISO: string;
    untilISO: string | null;
    recordedAtISO: string;
  } | null;
}

export interface FleetData {
  boats: FleetBoat[];
  todayISO: string;
}

/**
 * The fleet as the dock actually runs it: every ACTIVE activity is one physical
 * thing (a pontoon, a jet ski, a patio), with its current in/out-of-service
 * state and whether a repeating schedule is generating its departures.
 */
export async function loadFleetBoats(): Promise<FleetData> {
  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();

  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { timezone: true },
  });
  const timeZone = operator?.timezone ?? 'America/Los_Angeles';
  const todayISO = todayIsoIn(timeZone);

  const [activities, outages] = await Promise.all([
    db.activity.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ sort_index: 'asc' }, { name_internal: 'asc' }],
      select: {
        id: true,
        name_internal: true,
        name_external: true,
        color: true,
        category: true,
        schedule_rules: { select: { is_active: true } },
      },
    }),
    readFleetOutages(db, todayISO),
  ]);

  const boats: FleetBoat[] = activities.map((a) => {
    const outage = outages.get(a.id) ?? null;
    return {
      id: a.id,
      name: a.name_internal || a.name_external,
      category: a.category as string,
      color: a.color,
      hasActiveRule: a.schedule_rules.some((r) => r.is_active),
      outage: outage
        ? {
            reason: outage.reason,
            fromISO: outage.fromISO,
            untilISO: outage.untilISO,
            recordedAtISO: outage.recordedAtISO,
          }
        : null,
    };
  });

  return { boats, todayISO };
}

/** A staff member who can be scheduled as a guide (GUIDE role first). */
export interface GuideRosterEntry {
  id: string;
  name: string | null;
  email: string;
  role: string;
}

/**
 * Load the assignable-guide roster for the current operator. Guides are staff; we
 * surface the GUIDE role first but allow any active staffer to be scheduled (small
 * operators wear multiple hats). Tenant-scoped via the RLS client.
 */
export async function loadGuideRoster(): Promise<GuideRosterEntry[]> {
  const db = await getTenantDb();
  const staff = await db.staffMember.findMany({
    where: { is_active: true },
    select: { id: true, name: true, email: true, role: true },
    orderBy: [{ name: 'asc' }],
  });
  return staff
    .map((s) => ({ id: s.id, name: s.name, email: s.email, role: s.role as string }))
    .sort((a, b) => (b.role === 'GUIDE' ? 1 : 0) - (a.role === 'GUIDE' ? 1 : 0));
}
