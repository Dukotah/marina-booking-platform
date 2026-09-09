import { getOperatorContext, getTenantDb } from '../../lib/session';
import { localDayRangeUtc, localMinutesOfDay } from '../../components/manifest/tz';
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
