/**
 * Per-slot broadcast + message-one-guest — live integration against the seeded
 * LSRA tenant, exercised through the real Hono app so it covers the full wiring
 * the admin server actions depend on: tenant resolution, requireStaff +
 * order:write gate, zod validation, and the broadcast/message services.
 *
 * In test (NODE_ENV=test → sandbox local) email "sends" are captured to
 * SandboxMessage and report sent:true; SMS to a guest with no phone no-ops. That
 * lets these assert recipient/delivery counts deterministically with no Resend or
 * Twilio account.
 *
 * Proves:
 *   - broadcast reaches every LIVE booking on a slot (one per order) and EXCLUDES
 *     a cancelled item;
 *   - broadcast requires auth, a valid body, and at least one channel;
 *   - message-one-guest reaches the single order's guest;
 *   - an order with no contact details is a clean 400 (NO_CONTACT).
 *
 * Skips without DATABASE_URL. Cleans up everything it creates in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { app } from '../src/app.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';

const staffHeaders = {
  'x-operator-slug': SLUG,
  'x-dev-staff-id': 'dev-owner',
  'content-type': 'application/json',
};

describe.skipIf(!HAS_DB)('per-slot broadcast + message (live HTTP, LSRA seed)', () => {
  let activityId = '';
  let rateId = '';
  let capacity = 4;
  let createdStaff = false;
  const slotIds: string[] = [];
  const orderIds: string[] = [];
  const customerIds: string[] = [];

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
        price_cents: true,
        activity_id: true,
        activity: { select: { max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');
    activityId = rate.activity_id;
    rateId = rate.id;
    capacity = Math.max(rate.activity.max_participants, 4);

    const existing = await adminPrisma.staffMember.findFirst({
      where: { operator_id: OP, auth_user_id: 'dev-owner' },
      select: { id: true },
    });
    if (!existing) {
      await adminPrisma.staffMember.create({
        data: {
          operator_id: OP,
          auth_user_id: 'dev-owner',
          name: 'Dev Owner',
          email: 'dev-owner-broadcast-itest@example.com',
          role: 'OWNER',
          is_active: true,
        },
      });
      createdStaff = true;
    }
  });

  afterAll(async () => {
    // Items/sandbox messages/events cascade from their parents.
    for (const id of orderIds) await adminPrisma.order.deleteMany({ where: { id } });
    for (const id of slotIds) await adminPrisma.timeslot.deleteMany({ where: { id } });
    for (const id of customerIds) await adminPrisma.customer.deleteMany({ where: { id } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
    await adminPrisma.$disconnect();
  });

  async function futureSlot() {
    const slot = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        capacity_total: capacity,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    slotIds.push(slot.id);
    return slot.id;
  }

  /** Create a customer + a single-item order on a slot. */
  async function booking(
    timeslotId: string,
    opts: { email?: string; phone?: string | null; status?: 'UPCOMING' | 'CANCELLED' } = {},
  ) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const customer = await adminPrisma.customer.create({
      data: {
        operator_id: OP,
        first_name: 'Test',
        last_name: `Guest-${suffix}`,
        // Customer.email is a non-null column; an empty string stands in for
        // "no email on file" (the broadcast treats a blank address as no contact).
        email: opts.email === undefined ? `broadcast.${suffix}@example.com` : opts.email,
        phone: opts.phone ?? null,
      },
      select: { id: true },
    });
    customerIds.push(customer.id);
    const order = await adminPrisma.order.create({
      data: {
        operator_id: OP,
        customer_id: customer.id,
        order_number: `ITBC-${suffix}`,
        status: opts.status === 'CANCELLED' ? 'CANCELLED' : 'UPCOMING',
        created_by: 'STAFF',
        subtotal_cents: 0,
        total_cents: 0,
        amount_paid_cents: 0,
        balance_due_cents: 0,
        items: {
          // operator_id is derived from the parent order via the tenant-composite
          // relation; passing it explicitly is rejected.
          create: {
            activity_id: activityId,
            rate_id: rateId,
            timeslot_id: timeslotId,
            quantity: 1,
            unit_price_cents: 0,
            status: opts.status === 'CANCELLED' ? 'CANCELLED' : 'UPCOMING',
          },
        },
      },
      select: { id: true },
    });
    orderIds.push(order.id);
    return order.id;
  }

  it('rejects an unauthenticated caller', async () => {
    const slotId = await futureSlot();
    const res = await app.request(`/api/timeslots/${slotId}/broadcast`, {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an empty body and a no-channel send', async () => {
    const slotId = await futureSlot();
    const empty = await app.request(`/api/timeslots/${slotId}/broadcast`, {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ body: '   ' }),
    });
    expect(empty.status).toBe(400);

    const noChannel = await app.request(`/api/timeslots/${slotId}/broadcast`, {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ body: 'On a weather hold', email: false, sms: false }),
    });
    expect(noChannel.status).toBe(400);
    expect(await noChannel.json()).toMatchObject({ code: 'NO_CHANNEL' });
  });

  it('broadcasts to every live booking on the slot and excludes a cancelled one', async () => {
    const slotId = await futureSlot();
    await booking(slotId); // live, emailable
    await booking(slotId); // live, emailable
    await booking(slotId, { status: 'CANCELLED' }); // excluded

    const res = await app.request(`/api/timeslots/${slotId}/broadcast`, {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ body: 'Heads up — short weather hold, back by 2:30.' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      recipients: number;
      delivered: number;
      emailsSent: number;
    };
    expect(json.ok).toBe(true);
    expect(json.recipients).toBe(2); // the cancelled order is not addressed
    expect(json.emailsSent).toBe(2);
    expect(json.delivered).toBe(2);
  });

  it('404s an unknown timeslot', async () => {
    const res = await app.request('/api/timeslots/does-not-exist/broadcast', {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ body: 'hello' }),
    });
    expect(res.status).toBe(404);
  });

  it('messages one order guest', async () => {
    const slotId = await futureSlot();
    const orderId = await booking(slotId);
    const res = await app.request(`/api/orders/${orderId}/message`, {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ body: 'See you at the dock!' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, recipients: 1, delivered: 1 });
  });

  it('400s messaging a guest with no email or phone on file', async () => {
    const slotId = await futureSlot();
    const orderId = await booking(slotId, { email: '', phone: null });
    const res = await app.request(`/api/orders/${orderId}/message`, {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ body: 'Anyone home?' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'NO_CONTACT' });
  });
});
