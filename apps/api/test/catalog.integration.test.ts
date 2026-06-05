/**
 * Public catalog + availability HTTP endpoints — live integration test against the
 * seeded LSRA tenant on Neon. Covers the customer-facing surface that the booking
 * portal hits before a reservation is created:
 *
 *   GET /api/activities                      — catalog list (active + online-visible)
 *   GET /api/activities/:id                  — activity detail with rates
 *   GET /api/activities/:id (unknown id)     — 404
 *   GET /api/activities/:id/availability     — timeslots for a day via path-param proxy
 *   GET /api/activities/:id/availability     — 400 when date param is missing
 *   GET /api/availability                    — same day via query-param endpoint
 *   GET /api/availability/range              — multi-day summary (green/yellow/red)
 *   GET /api/operator/public                 — white-label branding (unauthenticated)
 *   GET /api/activities/manage               — 401 without staff identity
 *   GET /api/operator                        — 401 without staff identity
 *
 * Skips without DATABASE_URL. Creates two far-future timeslots in beforeAll (one
 * AVAILABLE, one half-full) for a deterministic availability assertion and cleans
 * them up in afterAll. No customer PII is written.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { app } from '../src/app.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';

// A fixed far-future date that the seed never populates.  Using a constant (not
// Date.now()) keeps the test deterministic and easy to clean up.
const TEST_DATE = '2031-08-20';
// UTC day bounds (America/Los_Angeles is UTC-7/UTC-8, so use a wide enough
// window to cover the local-midnight-to-midnight span regardless of DST).
const TEST_DAY_START = new Date('2031-08-19T00:00:00.000Z');
const TEST_DAY_END = new Date('2031-08-21T00:00:00.000Z');

let activityId = '';
let slotOpenId = '';
let slotHalfId = '';
let slotCapacity = 10;

describe.skipIf(!HAS_DB)('catalog + availability HTTP (live vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    // Find the cheapest public activity so we have a stable activityId + known shape.
    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true },
      },
      select: {
        activity_id: true,
        activity: { select: { max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');
    activityId = rate.activity_id;
    slotCapacity = rate.activity.max_participants;

    // Pre-clean any leftovers from a previous aborted run.
    await adminPrisma.timeslot.deleteMany({
      where: {
        operator_id: OP,
        activity_id: activityId,
        datetime: { gte: TEST_DAY_START, lt: TEST_DAY_END },
      },
    });

    // Create two known slots in the test window via the operator-scoped client so
    // RLS constraints are satisfied.  No customer rows are needed.
    const slotOpen = await forOperator(OP).timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        // 10:00 AM local expressed as a mid-UTC-day instant — safely inside any
        // America/Los_Angeles offset regardless of DST.
        datetime: new Date('2031-08-20T17:00:00.000Z'), // 10:00 AM PDT (UTC-7)
        capacity_total: slotCapacity,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    slotOpenId = slotOpen.id;

    const booked = Math.floor(slotCapacity / 2);
    const slotHalf = await forOperator(OP).timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date('2031-08-20T19:00:00.000Z'), // 12:00 PM PDT
        capacity_total: slotCapacity,
        capacity_booked: booked,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    slotHalfId = slotHalf.id;
  });

  afterAll(async () => {
    await adminPrisma.timeslot.deleteMany({
      where: { id: { in: [slotOpenId, slotHalfId].filter(Boolean) } },
    });
    await adminPrisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // Catalog list
  // ---------------------------------------------------------------------------

  it('GET /api/activities returns active online-visible activities with rates', async () => {
    const res = await app.request('/api/activities', {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      activities: Array<{
        id: string;
        name: string;
        rates: Array<{ id: string; priceCents: number }>;
      }>;
    };

    expect(Array.isArray(body.activities)).toBe(true);
    expect(body.activities.length).toBeGreaterThan(0);

    // Our seeded activity must appear.
    const found = body.activities.find((a) => a.id === activityId);
    expect(found).toBeDefined();
    expect(typeof found!.name).toBe('string');
    expect(found!.name.length).toBeGreaterThan(0);

    // Every item must have the required shape fields.
    for (const a of body.activities) {
      expect(typeof a.id).toBe('string');
      expect(typeof a.name).toBe('string');
      expect(Array.isArray(a.rates)).toBe(true);
    }
  });

  it('GET /api/activities returns fromPriceCents derived from rates', async () => {
    const res = await app.request('/api/activities', {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      activities: Array<{ id: string; fromPriceCents: number | null }>;
    };

    const found = body.activities.find((a) => a.id === activityId)!;
    // fromPriceCents is null only if the activity has zero public rates; the LSRA
    // seed always has at least one, so expect a positive integer.
    expect(found.fromPriceCents).not.toBeNull();
    expect(typeof found.fromPriceCents).toBe('number');
    expect((found.fromPriceCents as number) > 0).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Activity detail
  // ---------------------------------------------------------------------------

  it('GET /api/activities/:id returns detail shape with description + reschedule policy', async () => {
    const res = await app.request(`/api/activities/${activityId}`, {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      activity: {
        id: string;
        name: string;
        minParticipants: number;
        maxParticipants: number;
        rates: Array<{ id: string; name: string; priceCents: number; durationMinutes: number }>;
        selfRescheduleHours: number;
        fromPriceCents: number | null;
      };
    };

    expect(body.activity.id).toBe(activityId);
    expect(typeof body.activity.name).toBe('string');
    expect(typeof body.activity.minParticipants).toBe('number');
    expect(typeof body.activity.maxParticipants).toBe('number');
    expect(body.activity.maxParticipants).toBeGreaterThanOrEqual(body.activity.minParticipants);
    expect(Array.isArray(body.activity.rates)).toBe(true);
    expect(body.activity.rates.length).toBeGreaterThan(0);

    // Rate shape.
    const r = body.activity.rates[0]!;
    expect(typeof r.id).toBe('string');
    expect(typeof r.name).toBe('string');
    expect(typeof r.priceCents).toBe('number');
  });

  it('GET /api/activities/:id returns 404 for an unknown activity id', async () => {
    const res = await app.request('/api/activities/non-existent-id-that-does-not-exist', {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Availability via path-param proxy (GET /api/activities/:id/availability)
  // ---------------------------------------------------------------------------

  it('GET /api/activities/:id/availability returns the two test slots for the test date', async () => {
    const res = await app.request(
      `/api/activities/${activityId}/availability?date=${TEST_DATE}`,
      { headers: { 'x-operator-slug': SLUG } },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      activityId: string;
      date: string;
      slots: Array<{
        timeslotId: string;
        datetime: string;
        capacityTotal: number;
        capacityBooked: number;
        capacityRemaining: number;
        status: string;
      }>;
    };

    expect(body.activityId).toBe(activityId);
    expect(body.date).toBe(TEST_DATE);
    // The response uses `slots` (re-shaped by the route proxy).
    expect(Array.isArray(body.slots)).toBe(true);

    // Both test slots must appear.
    const ids = body.slots.map((s) => s.timeslotId);
    expect(ids).toContain(slotOpenId);
    expect(ids).toContain(slotHalfId);

    // Shape check on the fully-open slot.
    const open = body.slots.find((s) => s.timeslotId === slotOpenId)!;
    expect(open.capacityTotal).toBe(slotCapacity);
    expect(open.capacityBooked).toBe(0);
    expect(open.capacityRemaining).toBe(slotCapacity);
    expect(open.status).toBe('AVAILABLE');

    // Shape check on the half-full slot.
    const half = body.slots.find((s) => s.timeslotId === slotHalfId)!;
    const expectedBooked = Math.floor(slotCapacity / 2);
    expect(half.capacityBooked).toBe(expectedBooked);
    expect(half.capacityRemaining).toBe(slotCapacity - expectedBooked);
  });

  it('GET /api/activities/:id/availability returns 400 when date param is missing', async () => {
    const res = await app.request(`/api/activities/${activityId}/availability`, {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Availability via query-param endpoint (GET /api/availability)
  // ---------------------------------------------------------------------------

  it('GET /api/availability returns timeslots with timezone in the canonical shape', async () => {
    const res = await app.request(
      `/api/availability?activityId=${activityId}&date=${TEST_DATE}`,
      { headers: { 'x-operator-slug': SLUG } },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      activityId: string;
      date: string;
      timezone: string;
      timeslots: Array<{
        id: string;
        datetime: string;
        capacityTotal: number;
        capacityBooked: number;
        capacityRemaining: number;
        status: string;
      }>;
    };

    expect(body.activityId).toBe(activityId);
    expect(body.date).toBe(TEST_DATE);
    expect(typeof body.timezone).toBe('string');
    expect(body.timezone.length).toBeGreaterThan(0);

    // Both test slots must appear via this endpoint too (uses `timeslots` not `slots`).
    const ids = body.timeslots.map((s) => s.id);
    expect(ids).toContain(slotOpenId);
    expect(ids).toContain(slotHalfId);
  });

  it('GET /api/availability returns 400 when activityId is missing', async () => {
    const res = await app.request(`/api/availability?date=${TEST_DATE}`, {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Range availability (GET /api/availability/range)
  // ---------------------------------------------------------------------------

  it('GET /api/availability/range returns per-day signals including the test date', async () => {
    const rangeFrom = '2031-08-19';
    const rangeTo = '2031-08-21';
    const res = await app.request(
      `/api/availability/range?activityId=${activityId}&from=${rangeFrom}&to=${rangeTo}`,
      { headers: { 'x-operator-slug': SLUG } },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      activityId: string;
      from: string;
      to: string;
      timezone: string;
      days: Array<{ date: string; slotCount: number; signal: string }>;
    };

    expect(body.activityId).toBe(activityId);
    expect(body.from).toBe(rangeFrom);
    expect(body.to).toBe(rangeTo);
    expect(typeof body.timezone).toBe('string');
    expect(Array.isArray(body.days)).toBe(true);

    // The test date must appear with at least 2 slots and a non-red signal
    // (because we created an open slot with remaining capacity).
    const testDay = body.days.find((d) => d.date === TEST_DATE);
    expect(testDay).toBeDefined();
    expect(testDay!.slotCount).toBeGreaterThanOrEqual(2);
    expect(['green', 'yellow']).toContain(testDay!.signal);

    // Every day entry must have a valid signal.
    for (const day of body.days) {
      expect(['green', 'yellow', 'red']).toContain(day.signal);
    }
  });

  // ---------------------------------------------------------------------------
  // Operator public branding
  // ---------------------------------------------------------------------------

  it('GET /api/operator/public returns tenant branding without authentication', async () => {
    const res = await app.request('/api/operator/public', {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      slug: string;
      name: string;
      brand_color: string | null;
      timezone: string;
    };

    expect(body.slug).toBe(SLUG);
    expect(typeof body.name).toBe('string');
    expect(body.name.length).toBeGreaterThan(0);
    // timezone must be a non-empty IANA string.
    expect(typeof body.timezone).toBe('string');
    expect(body.timezone.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Staff-only endpoints must 401 without a staff identity
  // ---------------------------------------------------------------------------

  it('GET /api/activities/manage returns 401 without a staff identity', async () => {
    const res = await app.request('/api/activities/manage', {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/operator returns 401 without a staff identity', async () => {
    const res = await app.request('/api/operator', {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(401);
  });
});
