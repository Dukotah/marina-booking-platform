/**
 * Departures service — the data behind the customer homepage's availability-first
 * "Today's Departures" board (DESIGN.md "Speed mechanics": availability is
 * displayed, never queried).
 *
 * For one calendar day (operator timezone) it returns every still-bookable
 * timeslot across the whole online catalog, soonest first, each carrying the
 * ALL-IN price a solo guest would actually pay at checkout. It also returns a
 * 7-day rail summary (does the day have anything bookable + the cheapest all-in
 * price) so the guest can flick between days without a query round-trip.
 *
 * No new math lives here — that is the point:
 *   - availability comes from getDayAvailability / getRangeAvailability
 *     (services/availability.ts), the same rollups the booking calendar shows
 *     and the booking service enforces;
 *   - the per-unit price comes from priceSlot (services/pricing-rules.ts), THE
 *     single dynamic-pricing entry point that booking + quotes use;
 *   - the all-in total comes from @marina/core calculatePricing over the same
 *     fee rows the booking service loads, so the board's number equals the
 *     checkout total for quantity 1 (no promo/tip/membership).
 *
 * Day-rail min prices are computed with the same pure pipeline; DEMAND rules
 * simply don't fire there (no per-slot demand signal on a summary), which
 * matches how the quote flow treats an unknown booked ratio.
 */
import { calculatePricing, type PricingFee } from '@marina/core';
import type { TenantClient } from '@marina/database';
import { AvailabilityError, getDayAvailability, getRangeAvailability } from './availability.js';
import { loadRulesForRate, priceSlot } from './pricing-rules.js';
import { sandboxNow } from './payments-sandbox.js';

/** Days the rail summarises, starting at "today" in the operator timezone. */
export const RAIL_DAYS = 7;

/** Board rows are capped so the homepage stays a glance, not a spreadsheet. */
export const MAX_DEPARTURES = 12;

export interface DepartureRow {
  timeslotId: string;
  /** UTC instant of the departure, ISO-8601 (render in `timezone`). */
  datetime: string;
  activityId: string;
  activityName: string;
  category: string;
  /** First catalog photo, for the 1:1 board thumb. */
  photoUrl: string | null;
  /** Seats still bookable (true capacity, shared resources included). */
  seatsLeft: number;
  /** The rate the all-in price is quoted for (the cheapest online rate). */
  rateId: string;
  rateName: string;
  durationMinutes: number;
  /** What one guest pays at checkout, fees included. Integer cents. */
  allInCents: number;
}

export interface RailDay {
  /** Calendar day in the operator timezone, YYYY-MM-DD. */
  date: string;
  /** True when at least one activity has a bookable slot that day. */
  available: boolean;
  /** Cheapest all-in price across the catalog that day; null when unavailable. */
  minAllInCents: number | null;
}

export interface DeparturesResult {
  /** The board's day, YYYY-MM-DD in the operator timezone. */
  date: string;
  timezone: string;
  days: RailDay[];
  departures: DepartureRow[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar day of `instant` in `timeZone`, as YYYY-MM-DD (en-CA renders ISO). */
export function dayInTimezone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** YYYY-MM-DD plus n days (pure calendar math, timezone-independent). */
function addDays(isoDay: string, n: number): string {
  const [y, m, d] = isoDay.split('-').map(Number);
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, (d as number) + n));
  return dt.toISOString().slice(0, 10);
}

interface BoardActivity {
  id: string;
  name: string;
  category: string;
  photoUrl: string | null;
  /** Cheapest active, non-internal rate — what "from $" means everywhere else. */
  rate: { id: string; name: string; priceCents: number; durationMinutes: number };
  fees: PricingFee[];
}

/**
 * The activities the board can quote: online-visible, bookable, priced. An
 * activity with hide_price or no online rate cannot carry an honest all-in
 * number, so it stays in the browse catalog but off the board.
 */
async function loadBoardActivities(db: TenantClient): Promise<BoardActivity[]> {
  const rows = await db.activity.findMany({
    where: {
      status: 'ACTIVE',
      visible_online: true,
      hide_from_display: false,
      hide_price: false,
      rates: { some: { is_active: true, internal_only: false } },
    },
    orderBy: { sort_index: 'asc' },
    include: {
      rates: {
        where: { is_active: true, internal_only: false },
        orderBy: { price_cents: 'asc' },
        take: 1,
      },
    },
  });

  // One fee query for the whole board (same WHERE the booking service runs per
  // activity: enabled fees scoped to the activity or operator-wide).
  const feeRows = await db.fee.findMany({
    where: { enabled: true },
    select: { name: true, type: true, value: true, activity_id: true, is_tax: true },
    orderBy: { name: 'asc' },
  });

  return rows
    .filter((a) => a.rates.length > 0)
    .map((a) => {
      const r = a.rates[0]!;
      return {
        id: a.id,
        name: a.name_external,
        category: a.category,
        photoUrl: a.photo_urls[0] ?? null,
        rate: {
          id: r.id,
          name: r.name_external,
          priceCents: r.price_cents,
          durationMinutes: r.duration_minutes,
        },
        fees: feeRows
          .filter((f) => f.activity_id === null || f.activity_id === a.id)
          .map((f) => ({ name: f.name, type: f.type, value: f.value, isTax: f.is_tax })),
      };
    });
}

/**
 * The homepage departures board + 7-day rail for the resolved tenant.
 *
 * `date` is optional and defaults to "today" in the operator's timezone. For
 * today, departures whose start time has already passed are dropped — a guest
 * cannot board a boat that left.
 */
export async function getDepartures(
  db: TenantClient,
  operatorId: string,
  params: { date?: string } = {},
): Promise<DeparturesResult> {
  if (params.date !== undefined && !ISO_DATE_RE.test(params.date)) {
    throw new AvailabilityError('date must be a YYYY-MM-DD date');
  }

  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { timezone: true },
  });
  const timeZone = operator?.timezone ?? 'America/Los_Angeles';

  // The sandbox clock (not the wall clock) decides "now", exactly as pricing
  // and payments do — so a demo tenant with a shifted clock stays coherent.
  const now = await sandboxNow(db, operatorId);
  const today = dayInTimezone(now, timeZone);
  const date = params.date ?? today;

  const activities = await loadBoardActivities(db);

  // Pre-load each board activity's pricing rules once; priceSlot then prices
  // every slot/day without re-querying.
  const rulesByActivity = new Map(
    await Promise.all(
      activities.map(
        async (a) =>
          [a.id, await loadRulesForRate(db, { activityId: a.id, rateId: a.rate.id })] as const,
      ),
    ),
  );

  // ---- Board rows: every still-bookable slot on `date`, priced all-in. ----
  const rowsNested = await Promise.all(
    activities.map(async (a) => {
      const day = await getDayAvailability(db, { activityId: a.id, date });
      const open = day.timeslots.filter(
        (t) =>
          t.available &&
          t.capacityRemaining > 0 &&
          // For today's board a departure in the past is gone.
          (date !== today || new Date(t.datetime).getTime() > now.getTime()),
      );
      return Promise.all(
        open.map(async (t) => {
          const priced = await priceSlot(db, operatorId, {
            activityId: a.id,
            rateId: a.rate.id,
            basePriceCents: a.rate.priceCents,
            slotStart: new Date(t.datetime),
            capacityTotal: t.capacityTotal,
            capacityBooked: t.capacityBooked,
            now,
            rules: rulesByActivity.get(a.id),
          });
          const allIn = calculatePricing({
            items: [{ unitPriceCents: priced.priceCents, quantity: 1 }],
            fees: a.fees,
          });
          return {
            timeslotId: t.id,
            datetime: t.datetime,
            activityId: a.id,
            activityName: a.name,
            category: a.category,
            photoUrl: a.photoUrl,
            seatsLeft: t.capacityRemaining,
            rateId: a.rate.id,
            rateName: a.rate.name,
            durationMinutes: a.rate.durationMinutes,
            allInCents: allIn.totalCents,
          } satisfies DepartureRow;
        }),
      );
    }),
  );

  const departures = rowsNested
    .flat()
    .sort(
      (x, y) =>
        new Date(x.datetime).getTime() - new Date(y.datetime).getTime() ||
        x.allInCents - y.allInCents ||
        x.activityName.localeCompare(y.activityName),
    )
    .slice(0, MAX_DEPARTURES);

  // ---- 7-day rail: bookable? + cheapest all-in per day, from range rollups. ----
  const railFrom = today;
  const railTo = addDays(today, RAIL_DAYS - 1);
  const perActivityRanges = await Promise.all(
    activities.map(async (a) => {
      const range = await getRangeAvailability(db, { activityId: a.id, from: railFrom, to: railTo });
      return { activity: a, days: range.days };
    }),
  );

  const days: RailDay[] = [];
  for (let i = 0; i < RAIL_DAYS; i += 1) {
    const dayKey = addDays(today, i);
    let min: number | null = null;
    for (const { activity, days: actDays } of perActivityRanges) {
      const summary = actDays.find((d) => d.date === dayKey);
      if (!summary || summary.signal === 'red' || summary.capacityRemaining <= 0) continue;
      // Rail estimate uses the same pipeline; no per-slot demand signal exists at
      // day granularity, so DEMAND rules don't fire (bookedRatio omitted). The
      // date-time is noon local-ish purely for date-keyed (SEASONAL/WEEKEND)
      // rules; those compare calendar dates only.
      const priced = await priceSlot(db, operatorId, {
        activityId: activity.id,
        rateId: activity.rate.id,
        basePriceCents: activity.rate.priceCents,
        slotStart: new Date(`${dayKey}T12:00:00`),
        now,
        rules: rulesByActivity.get(activity.id),
      });
      const allIn = calculatePricing({
        items: [{ unitPriceCents: priced.priceCents, quantity: 1 }],
        fees: activity.fees,
      }).totalCents;
      if (min === null || allIn < min) min = allIn;
    }
    days.push({ date: dayKey, available: min !== null, minAllInCents: min });
  }

  return { date, timezone: timeZone, days, departures };
}
