/**
 * Calendar routes — live HTTP integration test against the seeded LSRA tenant.
 *
 * Exercises the real Hono app via `app.request(...)` for the two token/id-auth'd
 * routes mounted OUTSIDE the tenant middleware:
 *   GET /calendar/feed/:token(.ics)          operator subscribe feed
 *   GET /calendar/booking/:orderItemId(.ics) per-booking customer download
 *
 * Proves the whole chain: token → operator resolution via the owner client,
 * tenant-scoped data read, ICS document assembly (MIME, VCALENDAR/VEVENT
 * structure, escaping, stable UID), cancelled-order omission, and the 404
 * posture for bad/disabled tokens.
 *
 * Skips without DATABASE_URL. Creates its own bookings + the calendar_feed
 * Integration row and removes everything in afterAll (restoring any pre-existing
 * calendar_feed row untouched — it saves/restores the original config).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, type Prisma } from '@marina/database';
import { app } from '../src/app.js';
import { createBooking } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'calendar-itest@example.com';
const TOKEN = 'itest-calendar-feed-token-0123456789abcdef';

let activityId = '';
let rateId = '';
let qty = 1;
let slotCapacity = 1;
let durationMinutes = 60;
const createdOrderIds: string[] = [];
const createdTimeslotIds: string[] = [];

/** The pre-existing calendar_feed row (if any) so afterAll can restore it. */
let previousFeedRow: { enabled: boolean; config: Prisma.InputJsonValue } | null = null;

let order: Awaited<ReturnType<typeof createBooking>>;
let cancelledOrder: Awaited<ReturnType<typeof createBooking>>;

async function bookOne(daysOut: number) {
  const slot = await adminPrisma.timeslot.create({
    data: {
      operator_id: OP,
      activity_id: activityId,
      datetime: new Date(Date.now() + daysOut * 24 * 60 * 60 * 1000),
      capacity_total: slotCapacity,
      capacity_booked: 0,
      status: 'AVAILABLE',
    },
    select: { id: true },
  });
  createdTimeslotIds.push(slot.id);
  const created = await createBooking(
    OP,
    {
      activityId,
      rateId,
      timeslotId: slot.id,
      quantity: qty,
      customer: {
        first_name: 'Cal',
        last_name: 'Tester',
        email: TEST_EMAIL,
        phone: '7075550142',
      },
      participants: [],
    },
    { channel: 'CUSTOMER' },
  );
  createdOrderIds.push(created.id);
  return created;
}

describe.skipIf(!HAS_DB)('calendar API (live HTTP vs local Postgres, LSRA seed)', () => {
  beforeAll(async () => {
    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true },
      },
      select: {
        id: true,
        duration_minutes: true,
        activity_id: true,
        activity: { select: { min_participants: true, max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');
    activityId = rate.activity_id;
    rateId = rate.id;
    durationMinutes = rate.duration_minutes;
    qty = rate.activity.min_participants;
    slotCapacity = Math.max(rate.activity.max_participants, qty);

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });

    // Install the feed token, preserving whatever row the operator already had.
    const existing = await adminPrisma.integration.findUnique({
      where: { operator_id_key: { operator_id: OP, key: 'calendar_feed' } },
      select: { enabled: true, config: true },
    });
    if (existing) {
      previousFeedRow = {
        enabled: existing.enabled,
        config: existing.config as Prisma.InputJsonValue,
      };
    }
    await adminPrisma.integration.upsert({
      where: { operator_id_key: { operator_id: OP, key: 'calendar_feed' } },
      create: { operator_id: OP, key: 'calendar_feed', enabled: true, config: { token: TOKEN } },
      update: { enabled: true, config: { token: TOKEN } },
    });

    order = await bookOne(30);
    cancelledOrder = await bookOne(31);
    await adminPrisma.order.update({
      where: { id: cancelledOrder.id },
      data: { status: 'CANCELLED', items: { updateMany: { where: {}, data: { status: 'CANCELLED' } } } },
    });
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await adminPrisma.order.deleteMany({ where: { id } });
    for (const id of createdTimeslotIds) await adminPrisma.timeslot.deleteMany({ where: { id } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    if (previousFeedRow) {
      await adminPrisma.integration.update({
        where: { operator_id_key: { operator_id: OP, key: 'calendar_feed' } },
        data: previousFeedRow,
      });
    } else {
      await adminPrisma.integration.deleteMany({ where: { operator_id: OP, key: 'calendar_feed' } });
    }
    await adminPrisma.$disconnect();
  });

  it('GET /calendar/feed/:token.ics serves a valid ICS document for the operator', async () => {
    const res = await app.request(`/calendar/feed/${TOKEN}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');

    const body = await res.text();
    // Structure: one VCALENDAR, CRLF endings, VERSION before any VEVENT.
    expect(body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(body.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(body).toContain('VERSION:2.0');
    expect(body).toContain('METHOD:PUBLISH');
    expect((body.match(/BEGIN:VEVENT/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect((body.match(/BEGIN:VEVENT/g) ?? []).length).toBe(
      (body.match(/END:VEVENT/g) ?? []).length,
    );

    // Our booking is present, with a stable item-derived UID and correct times.
    const item = order.items[0]!;
    const unfolded = body.replace(/\r\n /g, '');
    expect(unfolded).toContain(`UID:${item.id}@marina-booking`);
    expect(unfolded).toContain(`(${order.order_number})`);
    expect(unfolded).toContain('Customer: Cal Tester');
    expect(unfolded).toContain('Waiver: not signed');
    expect(unfolded).toContain(`/orders/${order.id}`);

    // DTEND - DTSTART = rate duration for our event.
    const vevent = unfolded
      .split('BEGIN:VEVENT')
      .find((chunk) => chunk.includes(`UID:${item.id}@marina-booking`))!;
    const dtstart = vevent.match(/DTSTART:(\d{8}T\d{6}Z)/)![1]!;
    const dtend = vevent.match(/DTEND:(\d{8}T\d{6}Z)/)![1]!;
    const toDate = (s: string) =>
      new Date(
        `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`,
      );
    expect(toDate(dtend).getTime() - toDate(dtstart).getTime()).toBe(durationMinutes * 60_000);

    // Every physical line respects the 75-octet fold.
    for (const line of body.split('\r\n')) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    }
  });

  it('accepts the token without the .ics suffix', async () => {
    const res = await app.request(`/calendar/feed/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
  });

  it('omits cancelled bookings from the feed', async () => {
    const res = await app.request(`/calendar/feed/${TOKEN}.ics`);
    const body = (await res.text()).replace(/\r\n /g, '');
    expect(body).not.toContain(`(${cancelledOrder.order_number})`);
    expect(body).not.toContain(`UID:${cancelledOrder.items[0]!.id}@marina-booking`);
  });

  it('404s on a wrong token and on a disabled integration', async () => {
    const wrong = await app.request(`/calendar/feed/${'x'.repeat(40)}.ics`);
    expect(wrong.status).toBe(404);

    await adminPrisma.integration.update({
      where: { operator_id_key: { operator_id: OP, key: 'calendar_feed' } },
      data: { enabled: false },
    });
    try {
      const disabled = await app.request(`/calendar/feed/${TOKEN}.ics`);
      expect(disabled.status).toBe(404);
    } finally {
      await adminPrisma.integration.update({
        where: { operator_id_key: { operator_id: OP, key: 'calendar_feed' } },
        data: { enabled: true },
      });
    }
  });

  it('404s on a too-short token without touching the database', async () => {
    const res = await app.request('/calendar/feed/short.ics');
    expect(res.status).toBe(404);
  });

  it('GET /calendar/booking/:orderItemId.ics serves one event with no admin link or phone', async () => {
    const item = order.items[0]!;
    const res = await app.request(`/calendar/booking/${item.id}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="booking-${order.order_number}.ics"`,
    );

    const body = (await res.text()).replace(/\r\n /g, '');
    expect((body.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
    expect(body).toContain(`UID:${item.id}@marina-booking`);
    expect(body).toContain(`Order ${order.order_number}`);
    // Customer-facing: nothing the confirmation page doesn't already show.
    expect(body).not.toContain('/orders/');
    expect(body).not.toContain('Phone:');
    expect(body).not.toContain('Balance due');
  });

  it('404s the booking download for an unknown order item id', async () => {
    const res = await app.request('/calendar/booking/nope_not_an_item.ics');
    expect(res.status).toBe(404);
  });
});
