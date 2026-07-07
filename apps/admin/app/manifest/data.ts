import { getOperatorContext, getTenantDb } from '../../lib/session';
import { localDayRangeUtc, localMinutesOfDay } from '../../components/manifest/tz';
import type { ManifestBooking, ManifestRow } from '../../components/manifest/types';

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
          order_items: {
            where: { status: { not: 'CANCELLED' } },
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

  const rows: ManifestRow[] = activities.map((activity) => {
    let capacityTotal = 0;
    let capacityBooked = 0;
    const bookings: ManifestBooking[] = [];

    for (const slot of activity.timeslots) {
      capacityTotal += slot.capacity_total;
      capacityBooked += slot.capacity_booked;

      const startMin = localMinutesOfDay(slot.datetime, timeZone);
      for (const item of slot.order_items) {
        const durationMin = item.rate?.duration_minutes ?? 240;
        const endMin = Math.min(startMin + durationMin, 24 * 60);
        const cust = item.order.customer;
        const customerName = `${cust.first_name} ${cust.last_name}`.trim() || 'Guest';

        bookings.push({
          orderItemId: item.id,
          orderId: item.order.id,
          orderNumber: item.order.order_number,
          customerName,
          rateName: item.rate?.name_external || item.rate?.name_internal || 'Rate',
          quantity: item.quantity,
          status: item.status,
          startMin,
          endMin,
          startISO: slot.datetime.toISOString(),
          waiverSigned: item.waiver_signed,
          balanceDueCents: item.order.balance_due_cents,
          customerPhone: item.order.customer.phone ?? null,
        });

        totalBookings += 1;
        if (item.status === 'CHECKED_IN') checkedIn += 1;
      }
    }

    bookings.sort((a, b) => a.startMin - b.startMin);

    return {
      activityId: activity.id,
      activityName: activity.name_internal || activity.name_external,
      color: activity.color,
      capacityTotal,
      capacityBooked,
      bookings,
    };
  });

  return { timeZone, rows, totalBookings, checkedIn };
}
