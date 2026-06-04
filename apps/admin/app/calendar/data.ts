import { getOperatorContext, getTenantDb } from '../../lib/session';
import {
  localWeekRangeUtc,
  localMinutesOfDay,
  toLocalParts,
  todayIsoIn,
  addIsoDays,
} from '../../components/manifest/tz';
import type {
  WeekCalendarDay,
  WeekCalendarEvent,
} from '../../components/manifest/WeekCalendar';

/**
 * Load a full operator-local week of bookings for the week grid. We pull order items
 * across the week window via their timeslots, project each into operator-local day +
 * minutes, and tag it with the owning activity's color. All reads are tenant-scoped.
 */
export interface WeekData {
  timeZone: string;
  days: WeekCalendarDay[];
  events: WeekCalendarEvent[];
  totalBookings: number;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function loadWeek(weekStartIso: string): Promise<WeekData> {
  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();

  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { timezone: true },
  });
  const timeZone = operator?.timezone ?? 'America/Los_Angeles';

  const { startUtc, endUtc } = localWeekRangeUtc(weekStartIso, timeZone);

  // Build the seven day columns (operator-local).
  const todayIso = todayIsoIn(timeZone);
  const days: WeekCalendarDay[] = Array.from({ length: 7 }, (_, i) => {
    const iso = addIsoDays(weekStartIso, i);
    const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
    const weekdayIdx = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return {
      iso,
      weekday: WEEKDAY_LABELS[weekdayIdx],
      dayNum: String(d),
      isToday: iso === todayIso,
    };
  });
  const isoToIndex = new Map(days.map((d, i) => [d.iso, i]));

  const items = await db.orderItem.findMany({
    where: {
      operator_id: operatorId,
      status: { not: 'CANCELLED' },
      timeslot: { datetime: { gte: startUtc, lt: endUtc }, status: { not: 'CANCELLED' } },
    },
    select: {
      id: true,
      quantity: true,
      status: true,
      timeslot: { select: { datetime: true } },
      rate: { select: { name_external: true, name_internal: true, duration_minutes: true } },
      activity: { select: { name_internal: true, name_external: true, color: true } },
      order: {
        select: {
          id: true,
          order_number: true,
          customer: { select: { first_name: true, last_name: true } },
        },
      },
    },
    orderBy: { timeslot: { datetime: 'asc' } },
  });

  const events: WeekCalendarEvent[] = [];
  for (const item of items) {
    const dt = item.timeslot.datetime;
    const parts = toLocalParts(dt, timeZone);
    const iso = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(
      2,
      '0',
    )}`;
    const dayIndex = isoToIndex.get(iso);
    if (dayIndex === undefined) continue; // outside the visible week (DST edge)

    const startMin = localMinutesOfDay(dt, timeZone);
    const durationMin = item.rate?.duration_minutes ?? 240;
    const endMin = Math.min(startMin + durationMin, 24 * 60);
    const cust = item.order.customer;
    const customerName = `${cust.first_name} ${cust.last_name}`.trim() || 'Guest';

    events.push({
      orderItemId: item.id,
      orderId: item.order.id,
      orderNumber: item.order.order_number,
      dayIndex,
      startMin,
      endMin,
      startISO: dt.toISOString(),
      title: item.activity.name_internal || item.activity.name_external,
      subtitle: `${customerName} · ${item.rate?.name_external || item.rate?.name_internal || 'Rate'}`,
      color: item.activity.color,
      status: item.status,
    });
  }

  return { timeZone, days, events, totalBookings: events.length };
}
