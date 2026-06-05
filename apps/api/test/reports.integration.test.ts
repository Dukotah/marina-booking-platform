/**
 * Reports API — live integration test against the seeded LSRA tenant on Neon.
 *
 * Exercises all four report endpoints:
 *   GET /revenue         JSON revenue summary
 *   GET /revenue.csv     CSV download
 *   GET /bookings        JSON bookings summary
 *   GET /bookings.csv    CSV download
 *
 * Skips without DATABASE_URL. Creates its own timeslot + booking (+ the dev-owner
 * staff row if missing) and deletes everything it made in afterAll.
 *
 * Because `reports` is not yet registered in app.ts (the parent agent handles that),
 * we instantiate a minimal Hono app that wires tenantMiddleware + reports in the same
 * way app.ts does so the tests remain self-contained and don't require app.ts edits.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { AuthorizationError } from '@marina/auth';
import { adminPrisma, forOperator } from '@marina/database';
import { tenantMiddleware } from '../src/middleware/tenant.js';
import { reports } from '../src/routes/reports.js';
import { createBooking } from '../src/services/booking.js';
import type { Env } from '../src/context.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const TEST_EMAIL = 'reports-itest@example.com';

// ---------------------------------------------------------------------------
// Local test app — mirrors how app.ts registers routes
// ---------------------------------------------------------------------------

const testApp = new Hono<Env>();
const api = new Hono<Env>();
api.use('*', tenantMiddleware);
api.route('/reports', reports);
testApp.route('/api', api);
testApp.onError((err, c) => {
  if (err instanceof AuthorizationError) {
    return c.json({ error: err.message, permission: err.permission }, 403);
  }
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});

// ---------------------------------------------------------------------------
// Shared request headers
// ---------------------------------------------------------------------------

const staffHeaders = {
  'x-operator-slug': SLUG,
  'x-dev-staff-id': 'dev-owner',
  'content-type': 'application/json',
};
const publicHeaders = { 'x-operator-slug': SLUG };

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let timeslotId = '';
let orderId = '';
let createdStaff = false;
let orderTotalCents = 0;

describe.skipIf(!HAS_DB)('reports API (live HTTP vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    // Ensure dev-owner staff row exists (the dev shim maps x-dev-staff-id → this row).
    const existingStaff = await adminPrisma.staffMember.findFirst({
      where: { operator_id: OP, auth_user_id: 'dev-owner' },
      select: { id: true },
    });
    if (!existingStaff) {
      const loc = await adminPrisma.location.findFirst({
        where: { operator_id: OP },
        select: { id: true },
      });
      await adminPrisma.staffMember.create({
        data: {
          operator_id: OP,
          auth_user_id: 'dev-owner',
          name: 'Dev Owner',
          email: 'dev-owner@example.com',
          role: 'OWNER',
          is_active: true,
          locations: loc ? { create: { location_id: loc.id } } : undefined,
        },
      });
      createdStaff = true;
    }

    // Pick the cheapest public rate + activity from the LSRA seed.
    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true },
      },
      select: {
        id: true,
        activity_id: true,
        activity: { select: { min_participants: true, max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');

    const qty = rate.activity.min_participants;

    // Create a dedicated timeslot in the future.
    const slot = await forOperator(OP).timeslot.create({
      data: {
        operator_id: OP,
        activity_id: rate.activity_id,
        datetime: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000), // ~40 days out
        capacity_total: rate.activity.max_participants,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    timeslotId = slot.id;

    // Remove any leftover customer from a previous interrupted run.
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });

    const order = await createBooking(
      OP,
      {
        activityId: rate.activity_id,
        rateId: rate.id,
        timeslotId,
        quantity: qty,
        customer: { first_name: 'Reports', last_name: 'Itest', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    orderId = order.id;
    orderTotalCents = order.total_cents;
  });

  afterAll(async () => {
    if (orderId) await adminPrisma.order.deleteMany({ where: { id: orderId } });
    if (timeslotId) await adminPrisma.timeslot.deleteMany({ where: { id: timeslotId } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({
        where: { operator_id: OP, auth_user_id: 'dev-owner' },
      });
    }
    await adminPrisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // Auth guard
  // ---------------------------------------------------------------------------

  it('GET /api/reports/revenue returns 401 without the staff shim', async () => {
    const res = await testApp.request('/api/reports/revenue', { headers: publicHeaders });
    expect(res.status).toBe(401);
  });

  it('GET /api/reports/bookings returns 401 without the staff shim', async () => {
    const res = await testApp.request('/api/reports/bookings', { headers: publicHeaders });
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // Date validation
  // ---------------------------------------------------------------------------

  it('GET /api/reports/revenue returns 400 for invalid date format', async () => {
    const res = await testApp.request('/api/reports/revenue?from=not-a-date', {
      headers: staffHeaders,
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/reports/revenue returns 400 when from >= to', async () => {
    const res = await testApp.request('/api/reports/revenue?from=2025-01-10&to=2025-01-01', {
      headers: staffHeaders,
    });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // GET /api/reports/revenue — JSON
  // ---------------------------------------------------------------------------

  it('GET /api/reports/revenue returns a valid revenue report shape', async () => {
    const res = await testApp.request('/api/reports/revenue', { headers: staffHeaders });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      report: {
        from: string;
        to: string;
        grossCents: number;
        discountCents: number;
        taxCents: number;
        tipCents: number;
        refundCents: number;
        netCents: number;
        orderCount: number;
        byDay: Array<{
          date: string;
          grossCents: number;
          discountCents: number;
          taxCents: number;
          tipCents: number;
          netCents: number;
          orderCount: number;
        }>;
      };
    };

    expect(typeof body.report.from).toBe('string');
    expect(typeof body.report.to).toBe('string');
    expect(typeof body.report.grossCents).toBe('number');
    expect(typeof body.report.discountCents).toBe('number');
    expect(typeof body.report.taxCents).toBe('number');
    expect(typeof body.report.tipCents).toBe('number');
    expect(typeof body.report.refundCents).toBe('number');
    expect(typeof body.report.netCents).toBe('number');
    expect(typeof body.report.orderCount).toBe('number');
    expect(Array.isArray(body.report.byDay)).toBe(true);
  });

  it('GET /api/reports/revenue includes the test order in a wide range', async () => {
    // Use a 365-day range to make sure the freshly created order is captured.
    const from = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const to = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const res = await testApp.request(`/api/reports/revenue?from=${from}&to=${to}`, {
      headers: staffHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      report: {
        grossCents: number;
        orderCount: number;
        byDay: Array<{ grossCents: number; orderCount: number }>;
      };
    };

    // Our order is UPCOMING (non-cancelled) so it must contribute to gross revenue.
    expect(body.report.grossCents).toBeGreaterThanOrEqual(orderTotalCents);
    expect(body.report.orderCount).toBeGreaterThanOrEqual(1);
    // byDay must sum to the total gross.
    const dayGross = body.report.byDay.reduce((sum, d) => sum + d.grossCents, 0);
    expect(dayGross).toBe(body.report.grossCents);
  });

  it('GET /api/reports/revenue excludes cancelled orders from gross', async () => {
    // Future-only range: guaranteed no seed orders but our own.
    const from = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const res = await testApp.request(`/api/reports/revenue?from=${from}&to=${to}`, {
      headers: staffHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { report: { grossCents: number } };
    // Our order is UPCOMING, so gross must be >= its total.
    expect(body.report.grossCents).toBeGreaterThanOrEqual(orderTotalCents);
  });

  // ---------------------------------------------------------------------------
  // GET /api/reports/bookings — JSON
  // ---------------------------------------------------------------------------

  it('GET /api/reports/bookings returns byStatus with the four known statuses', async () => {
    const res = await testApp.request('/api/reports/bookings', { headers: staffHeaders });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      report: {
        from: string;
        to: string;
        byStatus: Record<string, number>;
        topActivities: Array<{
          activityId: string;
          activityName: string;
          bookingCount: number;
          totalQuantity: number;
        }>;
      };
    };

    expect(typeof body.report.from).toBe('string');
    expect(typeof body.report.to).toBe('string');
    expect(typeof body.report.byStatus.UPCOMING).toBe('number');
    expect(typeof body.report.byStatus.COMPLETED).toBe('number');
    expect(typeof body.report.byStatus.CANCELLED).toBe('number');
    expect(typeof body.report.byStatus.NO_SHOW).toBe('number');
    expect(Array.isArray(body.report.topActivities)).toBe(true);
  });

  it('GET /api/reports/bookings includes our UPCOMING test order in the count', async () => {
    const from = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const to = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const res = await testApp.request(`/api/reports/bookings?from=${from}&to=${to}`, {
      headers: staffHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      report: {
        byStatus: Record<string, number>;
        topActivities: Array<{ bookingCount: number; totalQuantity: number }>;
      };
    };

    expect(body.report.byStatus.UPCOMING).toBeGreaterThanOrEqual(1);
    // topActivities must have at least one entry (from the seed + our order)
    expect(body.report.topActivities.length).toBeGreaterThanOrEqual(1);
    // Each activity must have positive booking count and total quantity
    for (const act of body.report.topActivities) {
      expect(act.bookingCount).toBeGreaterThan(0);
      expect(act.totalQuantity).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/reports/revenue.csv — CSV download
  // ---------------------------------------------------------------------------

  it('GET /api/reports/revenue.csv returns text/csv with correct headers', async () => {
    const res = await testApp.request('/api/reports/revenue.csv', { headers: staffHeaders });
    expect(res.status).toBe(200);

    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType.toLowerCase()).toContain('text/csv');

    const contentDisposition = res.headers.get('content-disposition') ?? '';
    expect(contentDisposition).toContain('attachment');
    expect(contentDisposition).toContain('revenue-');
    expect(contentDisposition).toContain('.csv');
  });

  it('GET /api/reports/revenue.csv body has a header row and data rows', async () => {
    const from = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const to = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const res = await testApp.request(`/api/reports/revenue.csv?from=${from}&to=${to}`, {
      headers: staffHeaders,
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');

    // First line is the report label
    expect(lines[0]).toContain('Revenue Summary');

    // The per-day header line must be present
    const dayHeaderIdx = lines.findIndex((l) => l.includes('Date') && l.includes('Gross Cents'));
    expect(dayHeaderIdx).toBeGreaterThanOrEqual(0);

    // There must be at least one data row after the per-day header (our order).
    expect(lines.length).toBeGreaterThan(dayHeaderIdx + 1);
  });

  it('GET /api/reports/revenue.csv returns 401 without the staff shim', async () => {
    const res = await testApp.request('/api/reports/revenue.csv', { headers: publicHeaders });
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // GET /api/reports/bookings.csv — CSV download
  // ---------------------------------------------------------------------------

  it('GET /api/reports/bookings.csv returns text/csv with correct headers', async () => {
    const res = await testApp.request('/api/reports/bookings.csv', { headers: staffHeaders });
    expect(res.status).toBe(200);

    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType.toLowerCase()).toContain('text/csv');

    const contentDisposition = res.headers.get('content-disposition') ?? '';
    expect(contentDisposition).toContain('attachment');
    expect(contentDisposition).toContain('bookings-');
    expect(contentDisposition).toContain('.csv');
  });

  it('GET /api/reports/bookings.csv body has status section and activity header', async () => {
    const from = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const to = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const res = await testApp.request(`/api/reports/bookings.csv?from=${from}&to=${to}`, {
      headers: staffHeaders,
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');

    // First line is the report label
    expect(lines[0]).toContain('Bookings Summary');

    // Status section header
    expect(lines.some((l) => l.includes('Status') && l.includes('Count'))).toBe(true);

    // Should include the four status rows
    expect(lines.some((l) => l.startsWith('UPCOMING'))).toBe(true);
    expect(lines.some((l) => l.startsWith('CANCELLED'))).toBe(true);

    // Activity section header
    expect(lines.some((l) => l.includes('Activity ID') && l.includes('Activity Name'))).toBe(true);
  });

  it('GET /api/reports/bookings.csv returns 401 without the staff shim', async () => {
    const res = await testApp.request('/api/reports/bookings.csv', { headers: publicHeaders });
    expect(res.status).toBe(401);
  });
});
