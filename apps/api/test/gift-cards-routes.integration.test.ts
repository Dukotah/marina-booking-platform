/**
 * Gift cards API — live HTTP integration test against the seeded LSRA tenant.
 * Where gift-cards.integration.test.ts drives the service functions directly, this
 * exercises the real Hono app via `app.request(...)`, so it covers the FULL endpoint
 * wiring the POS gift-card tender relies on:
 *   - tenant-resolution middleware (`x-operator-slug`),
 *   - the dev-staff auth shim (`x-dev-staff-id`) on the staff-only issue/list routes,
 *   - zod request validation, and
 *   - the response shapes the register and customer checkout read.
 *
 * The four routes:
 *   POST /api/gift-cards          staff  — issue a card (operator:manage)
 *   GET  /api/gift-cards/:code    public — balance/validity check
 *   POST /api/gift-cards/redeem   public — apply a card to an order (POS tender)
 *   GET  /api/gift-cards          staff  — list + outstanding liability
 *
 * We prove the tender path the POS uses end to end: issue -> balance check ->
 * partial redeem (remainder still owed) -> reject invalid + void codes. Money math
 * itself is covered by the service test; here the emphasis is the route contract.
 *
 * Skips without DATABASE_URL. Creates its own booking + (if missing) the dev-owner
 * staff row, and deletes everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { app } from '../src/app.js';
import { createBooking } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma'; // operator.slug -> resolves to operator id 'lsra'
const TEST_EMAIL = 'giftcard-routes-itest@example.com';

const publicHeaders = { 'x-operator-slug': SLUG };
const staffJsonHeaders = {
  'x-operator-slug': SLUG,
  'x-dev-staff-id': 'dev-owner',
  'content-type': 'application/json',
};

let activityId = '';
let rateId = '';
let qty = 1;
let slotCapacity = 1;
let createdStaff = false;
const createdOrderIds: string[] = [];
const createdCardIds: string[] = [];
const createdTimeslotIds: string[] = [];

describe.skipIf(!HAS_DB)('gift cards API (live HTTP vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    // The dev shim resolves `x-dev-staff-id: dev-owner` to this staff row; create it
    // if the seed omitted it (and remember so we can clean it up).
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
    activityId = rate.activity_id;
    rateId = rate.id;
    qty = rate.activity.min_participants;
    slotCapacity = Math.max(rate.activity.max_participants, qty);

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await adminPrisma.order.deleteMany({ where: { id } });
    for (const id of createdCardIds) await adminPrisma.giftCard.deleteMany({ where: { id } });
    for (const id of createdTimeslotIds) await adminPrisma.timeslot.deleteMany({ where: { id } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
    await adminPrisma.$disconnect();
  });

  /** Book a fresh order (own timeslot) so tests never share capacity or balance. */
  async function bookOne() {
    const slot = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000),
        capacity_total: slotCapacity,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    createdTimeslotIds.push(slot.id);
    const order = await createBooking(
      OP,
      {
        activityId,
        rateId,
        timeslotId: slot.id,
        quantity: qty,
        customer: { first_name: 'Gift', last_name: 'Routes', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    createdOrderIds.push(order.id);
    return order;
  }

  it('POST /api/gift-cards issues a card (staff) and rejects a bad amount', async () => {
    const res = await app.request('/api/gift-cards', {
      method: 'POST',
      headers: staffJsonHeaders,
      body: JSON.stringify({ initialCents: 5000, recipientName: 'Routes Tester' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { giftCard: { id: string; code: string; balance_cents: number; status: string } };
    expect(body.giftCard.balance_cents).toBe(5000);
    expect(body.giftCard.status).toBe('ACTIVE');
    expect(body.giftCard.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    createdCardIds.push(body.giftCard.id);

    // Zod rejects a non-positive amount before the handler runs.
    const bad = await app.request('/api/gift-cards', {
      method: 'POST',
      headers: staffJsonHeaders,
      body: JSON.stringify({ initialCents: 0 }),
    });
    expect(bad.status).toBe(400);
  });

  it('POST /api/gift-cards requires staff auth', async () => {
    const res = await app.request('/api/gift-cards', {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' }, // no staff id
      body: JSON.stringify({ initialCents: 1000 }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/gift-cards/:code reports balance for a valid card (public)', async () => {
    const issue = await app.request('/api/gift-cards', {
      method: 'POST',
      headers: staffJsonHeaders,
      body: JSON.stringify({ initialCents: 3000 }),
    });
    const { giftCard } = (await issue.json()) as { giftCard: { id: string; code: string } };
    createdCardIds.push(giftCard.id);

    // Public balance check — lower-cased to prove case-insensitive normalization.
    const res = await app.request(`/api/gift-cards/${giftCard.code.toLowerCase()}`, {
      headers: publicHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; balanceCents: number; status: string };
    expect(body.valid).toBe(true);
    expect(body.balanceCents).toBe(3000);
    expect(body.status).toBe('ACTIVE');
  });

  it('GET /api/gift-cards/:code rejects an unknown code (public)', async () => {
    const res = await app.request('/api/gift-cards/ZZZZ-ZZZZ-ZZZZ', { headers: publicHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; reason?: string };
    expect(body.valid).toBe(false);
    expect(body.reason).toMatch(/no gift card/i);
  });

  it('POST /api/gift-cards/redeem applies a partial tender, leaving a remainder', async () => {
    const issue = await app.request('/api/gift-cards', {
      method: 'POST',
      headers: staffJsonHeaders,
      body: JSON.stringify({ initialCents: 2000 }),
    });
    const { giftCard } = (await issue.json()) as { giftCard: { id: string; code: string } };
    createdCardIds.push(giftCard.id);

    const order = await bookOne();
    expect(order.total_cents).toBeGreaterThan(2000); // seed rate exceeds the card

    const res = await app.request('/api/gift-cards/redeem', {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' }, // public
      body: JSON.stringify({ code: giftCard.code, orderId: order.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      appliedCents: number;
      cardBalanceCents: number;
      cardStatus: string;
      orderAmountPaidCents: number;
      orderBalanceDueCents: number;
    };
    // Whole card balance applied; order still owes the remainder (settled by cash/card at the register).
    expect(body.appliedCents).toBe(2000);
    expect(body.cardBalanceCents).toBe(0);
    expect(body.cardStatus).toBe('REDEEMED');
    expect(body.orderAmountPaidCents).toBe(2000);
    expect(body.orderBalanceDueCents).toBe(order.total_cents - 2000);

    // A GIFT_CARD Payment row was written and linked to the card.
    const payment = await adminPrisma.payment.findFirst({
      where: { operator_id: OP, order_id: order.id, method: 'GIFT_CARD', gift_card_id: giftCard.id },
      select: { amount_cents: true },
    });
    expect(payment?.amount_cents).toBe(2000);
  });

  it('POST /api/gift-cards/redeem rejects a VOID card and an unknown code', async () => {
    const issue = await app.request('/api/gift-cards', {
      method: 'POST',
      headers: staffJsonHeaders,
      body: JSON.stringify({ initialCents: 4000 }),
    });
    const { giftCard } = (await issue.json()) as { giftCard: { id: string; code: string } };
    createdCardIds.push(giftCard.id);
    await adminPrisma.giftCard.update({ where: { id: giftCard.id }, data: { status: 'VOID' } });

    const order = await bookOne();

    const voided = await app.request('/api/gift-cards/redeem', {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ code: giftCard.code, orderId: order.id }),
    });
    expect(voided.status).toBe(400);
    const voidBody = (await voided.json()) as { error: string; code: string };
    expect(voidBody.code).toBe('VOID');

    const unknown = await app.request('/api/gift-cards/redeem', {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ZZZZ-ZZZZ-ZZZZ', orderId: order.id }),
    });
    expect(unknown.status).toBe(404);

    // The order was never touched by either failed redeem.
    const fresh = await adminPrisma.order.findUnique({
      where: { id: order.id },
      select: { amount_paid_cents: true },
    });
    expect(fresh?.amount_paid_cents).toBe(0);
  });

  it('GET /api/gift-cards lists cards + liability (staff)', async () => {
    const res = await app.request('/api/gift-cards', { headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { giftCards: unknown[]; liabilityCents: number };
    expect(Array.isArray(body.giftCards)).toBe(true);
    expect(typeof body.liabilityCents).toBe('number');
    expect(body.liabilityCents).toBeGreaterThanOrEqual(0);
  });
});
