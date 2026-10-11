import {
  freeRangesForDay,
  rentableRangesForDay,
  type MinuteRange,
  type RentalWindowRule,
} from '@marina/core';
import { getOperatorContext, getTenantDb } from '../../lib/session';
import { localDayRangeUtc, localMinutesOfDay, todayIsoIn } from '../../components/manifest/tz';
import type {
  ManifestBooking,
  ManifestClosure,
  ManifestGuide,
  ManifestRow,
  ManifestSlot,
  ManifestWaitlistEntry,
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

/** The rental-window ScheduleRule columns the band math reads. */
interface RuleRow {
  start_date: string;
  end_date: string;
  weekdays: number[];
  start_minutes: number[];
  open_minute: number | null;
  close_minute: number | null;
  is_active: boolean;
}

/**
 * The rentable "available to rent" bands for one boat on one day: the union of its
 * active rental-window rules for this weekday/season, with any whole-day blackout
 * removed and the day's bookings carved out — the SAME core math the booking engine
 * uses (rentableRangesForDay → freeRangesForDay), so the board can never show a band
 * the booking path would refuse.
 *
 * Only open-duration rules feed this (open/close set, start_minutes EMPTY). Fixed-
 * departure tour boats carry no such rule, so they get an empty band list and fall
 * back to the discrete "+N open slot" rendering. A whole-day closure (any blackout
 * covering this boat) yields no band — the closed overlay already tells that story.
 */
function rentableBandsForBoat(
  rules: RuleRow[],
  isoDate: string,
  taken: readonly MinuteRange[],
  closed: boolean,
): MinuteRange[] {
  if (closed) return [];
  const windows: RentalWindowRule[] = rules
    .filter((r) => r.open_minute !== null && r.close_minute !== null && r.start_minutes.length === 0)
    .map((r) => ({
      startDate: r.start_date,
      endDate: r.end_date,
      weekdays: r.weekdays,
      openMinute: r.open_minute,
      closeMinute: r.close_minute,
      isActive: r.is_active,
    }));
  if (windows.length === 0) return [];
  const rentable = rentableRangesForDay(windows, isoDate);
  if (rentable.length === 0) return [];
  return freeRangesForDay(rentable, taken);
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

  // BlackoutDate rows store the calendar day as a UTC-midnight instant for the
  // typed YYYY-MM-DD (see the schema note), so match on that exact instant — not a
  // tz-projected range, which would shift it a day west of Greenwich. A row with a
  // set activity_id closes just that boat; a null activity_id is operator/location
  // wide and closes every boat that day.
  const blackoutDayUtc = new Date(`${isoDate}T00:00:00.000Z`);

  // Activities that have timeslots in the window, with the slots + their bookings.
  const [activities, blackouts] = await Promise.all([
    db.activity.findMany({
    where: {
      operator_id: operatorId,
      status: 'ACTIVE',
      // Show a boat on the board when it has either a fixed departure that day OR a
      // rental window. Rental boats carry NO timeslots (the guest picks any start),
      // so the timeslot-only filter would hide them — the rental-rule clause keeps
      // every rentable boat's "available to rent" band on screen even on an
      // otherwise empty day.
      OR: [
        { timeslots: { some: { datetime: { gte: startUtc, lt: endUtc } } } },
        {
          schedule_rules: {
            some: { is_active: true, open_minute: { not: null }, close_minute: { not: null } },
          },
        },
      ],
    },
    select: {
      id: true,
      name_internal: true,
      name_external: true,
      color: true,
      sort_index: true,
      // Rental-window rules for this boat: the open-duration windows the "available
      // to rent" band is derived from. Fixed-departure rules (start_minutes set) are
      // pulled too but filtered out below — only open/close windows feed the band.
      schedule_rules: {
        where: { is_active: true },
        select: {
          start_date: true,
          end_date: true,
          weekdays: true,
          start_minutes: true,
          open_minute: true,
          close_minute: true,
          is_active: true,
        },
      },
      // Representative rate duration for the row's OPEN blocks: a slot has no
      // intrinsic length, so an available block spans the same width a booking on
      // this activity would. Shortest active rate wins (the conservative default
      // the booking engine would offer first); falls back to 240 when none.
      rates: {
        where: { is_active: true },
        orderBy: { duration_minutes: 'asc' },
        take: 1,
        select: { duration_minutes: true },
      },
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
          // Guests waiting on this (sold-out) slot — the departure card shows
          // "N on waitlist" and lets staff remove entries. Oldest first = the
          // order they would be notified in.
          waitlist_entries: {
            where: { status: { in: ['PENDING', 'NOTIFIED'] } },
            select: { id: true, name: true, email: true, status: true },
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
    }),
    // Same-day closures. Tenant-scoped via the RLS client; operator_id kept for
    // index use. Pull the activity scope + reason so a row can tell a boat-specific
    // outage from an operator-wide blackout.
    db.blackoutDate.findMany({
      where: { operator_id: operatorId, date: blackoutDayUtc },
      select: { activity_id: true, reason: true },
    }),
  ]);

  // Operator/location-wide blackouts (null activity_id) close every boat; boat-
  // scoped ones close just that activity. Collapse into a per-activity closure list
  // plus the day-wide set so the row builder can stamp each row.
  const wideClosures: ManifestClosure[] = blackouts
    .filter((b) => !b.activity_id)
    .map((b) => ({ reason: b.reason, wide: true }));
  const closuresByActivity = new Map<string, ManifestClosure[]>();
  for (const b of blackouts) {
    if (!b.activity_id) continue;
    const list = closuresByActivity.get(b.activity_id) ?? [];
    list.push({ reason: b.reason, wide: false });
    closuresByActivity.set(b.activity_id, list);
  }

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
    // Representative slot length for this boat's OPEN blocks (see the rates select).
    const slotDurationMin = activity.rates[0]?.duration_minutes ?? 240;

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
        // Clamp to 24:00 for same-day positioning, exactly like a booking's endMin.
        endMin: Math.min(startMin + slotDurationMin, 24 * 60),
        capacityTotal: slot.capacity_total,
        capacityBooked: slot.capacity_booked,
        guides: slotGuides,
        waitlist: slot.waitlist_entries.map((w) => ({
          id: w.id,
          name: w.name,
          email: w.email,
          status: w.status as ManifestWaitlistEntry['status'],
        })),
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

    const closures = [...(closuresByActivity.get(activity.id) ?? []), ...wideClosures];

    // The rentable band carves out spans a LIVE booking already holds; cancelled
    // items (loaded for the list view) free their time back up. Each booking uses
    // its wall-clock span on this day: startMin..endMin, which is already clamped to
    // 24:00, matching the half-open minute math the band union runs in.
    const takenSpans: MinuteRange[] = bookings
      .filter((b) => b.status !== 'CANCELLED')
      .map((b) => ({ open: b.startMin, close: b.endMin }));
    const rentableBands = rentableBandsForBoat(
      activity.schedule_rules as RuleRow[],
      isoDate,
      takenSpans,
      closures.length > 0,
    );

    return {
      activityId: activity.id,
      activityName: activity.name_internal || activity.name_external,
      color: activity.color,
      capacityTotal,
      capacityBooked,
      slots,
      guides: Array.from(guideById.values()),
      bookings,
      closures,
      rentableBands,
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
