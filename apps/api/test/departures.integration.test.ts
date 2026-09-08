/**
 * Departures API — live HTTP integration test against the seeded LSRA tenant.
 *
 * The homepage "Today's Departures" board promises two things the funnel dies
 * without:
 *   1. every row is genuinely bookable (available slots only, seats counted
 *      from true capacity), and
 *   2. the all-in price on the board is THE number checkout charges — computed
 *      here independently via the same priceSlot + calculatePricing + fee rows
 *      pipeline the booking service uses, and compared to the endpoint's answer.
 *
 * Exercises the real Hono app via app.request(...), so tenant resolution
 * (x-operator-slug), validation, and the response shape the web page reads are
 * all covered.
 *
 * Skips without DATABASE_URL. Generates slots only for a far-future day the
 * seed never touches and deletes them in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { calculatePricing } from '@marina/core';
import { app } from '../src/app.js';
import { generateTimeslotsForRange } from '../src/services/availability.js';
import { priceSlot } from '../src/services/pricing-rules.js';
import { RAIL_DAYS, type DeparturesResult } from '../src/services/departures.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma'; // operator.slug -> resolves to operator id 'lsra'
const publicHeaders = { 'x-operator-slug': SLUG };

// A fixed far-future day (UTC) the seed never populates — deterministic + easy
// to clean up. Early hours so these rows sort ahead of anything unexpected.
const DAY = '2030-08-20';
const DAY_START = new Date('2030-08-19T00:00:00.000Z');
const DAY_END = new Date('2030-08-21T00:00:00.000Z');
const CAPACITY = 4;

let activityId = '';
let cheapestRateId = '';
let cheapestRateCents = 0;

describe.skipIf(!HAS_DB)('departures API (live HTTP vs seeded LSRA tenant)', () => {
  beforeAll(async () => {
    // A bookable, priced activity — the same eligibility the board itself uses.
    const activity = await adminPrisma.activity.findFirst({
      where: {
        operator_id: OP,
        status: 'ACTIVE',
        visible_online: true,
        hide_from_display: false,
        hide_price: false,
        rates: { some: { is_active: true, internal_only: false } },
      },
      select: {
        id: true,
        rates: {
          where: { is_active: true, internal_only: false },
          orderBy: { price_cents: 'asc' },
          take: 1,
          select: { id: true, price_cents: true },
        },
      },
    });
    if (!activity || activity.rates.length === 0) {
      throw new Error('No bookable activity in the LSRA seed — run `pnpm db:seed`.');
    }
    activityId = activity.id;
    cheapestRateId = activity.rates[0]!.id;
    cheapestRateCents = activity.rates[0]!.price_cents;

    await adminPrisma.timeslot.deleteMany({
      where: { operator_id: OP, activity_id: activityId, datetime: { gte: DAY_START, lt: DAY_END } },
    });

    // 8:00–11:00 hourly => 3 slots on the test day.
    await generateTimeslotsForRange(forOperator(OP), {
      operatorId: OP,
      activityId,
      from: DAY,
      to: DAY,
      openHour: 8,
      closeHour: 11,
      intervalMinutes: 60,
      capacityTotal: CAPACITY,
    });
  });

  afterAll(async () => {
    await adminPrisma.timeslot.deleteMany({
      where: { operator_id: OP, activity_id: activityId, datetime: { gte: DAY_START, lt: DAY_END } },
    });
    await adminPrisma.$disconnect();
  });

  it('returns the board for a day: available rows, soonest first, capped rail', async () => {
    const res = await app.request(`/api/departures?date=${DAY}`, { headers: publicHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DeparturesResult;

    expect(body.date).toBe(DAY);
    expect(typeof body.timezone).toBe('string');
    // The rail always summarises RAIL_DAYS days starting today (not the queried day).
    expect(body.days).toHaveLength(RAIL_DAYS);

    // Our generated slots are on the board, bookable, with true seats left.
    const mine = body.departures.filter((d) => d.activityId === activityId);
    expect(mine.length).toBeGreaterThan(0);
    for (const row of mine) {
      expect(row.seatsLeft).toBeGreaterThan(0);
      expect(row.seatsLeft).toBeLessThanOrEqual(CAPACITY);
      expect(row.rateId).toBe(cheapestRateId);
      expect(row.allInCents).toBeGreaterThan(0);
      expect(row.datetime.slice(0, 4)).toBe('2030');
    }

    // Sorted soonest-first.
    const times = body.departures.map((d) => new Date(d.datetime).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("board price is checkout's price: priceSlot + fees + calculatePricing agree", async () => {
    const res = await app.request(`/api/departures?date=${DAY}`, { headers: publicHeaders });
    const body = (await res.json()) as DeparturesResult;
    const row = body.departures.find((d) => d.activityId === activityId);
    expect(row).toBeDefined();

    // Recompute independently through the SAME pipeline the booking service uses
    // (services/booking.ts): dynamic per-unit price for this exact slot, then the
    // fee math over the activity/operator fee rows.
    const db = forOperator(OP);
    const slot = await adminPrisma.timeslot.findUnique({
      where: { id: row!.timeslotId },
      select: { datetime: true, capacity_total: true, capacity_booked: true },
    });
    expect(slot).not.toBeNull();
    const priced = await priceSlot(db, OP, {
      activityId,
      rateId: cheapestRateId,
      basePriceCents: cheapestRateCents,
      slotStart: slot!.datetime,
      capacityTotal: slot!.capacity_total,
      capacityBooked: slot!.capacity_booked,
    });
    const feeRows = await adminPrisma.fee.findMany({
      where: { operator_id: OP, enabled: true, OR: [{ activity_id: activityId }, { activity_id: null }] },
      select: { name: true, type: true, value: true },
    });
    const expected = calculatePricing({
      items: [{ unitPriceCents: priced.priceCents, quantity: 1 }],
      fees: feeRows.map((f) => ({ name: f.name, type: f.type, value: f.value })),
    }).totalCents;

    expect(row!.allInCents).toBe(expected);
  });

  it('rejects a malformed date with 400', async () => {
    const res = await app.request('/api/departures?date=not-a-day', { headers: publicHeaders });
    expect(res.status).toBe(400);
  });
});
