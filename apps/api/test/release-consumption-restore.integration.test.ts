/**
 * fail-02 regression — a declined/abandoned checkout must not permanently burn the
 * one-time consumptions the create tx made. createBooking bumps PromoCode
 * .times_redeemed and spends punch-card uses up front, in a tx separate from the
 * later payment; a decline routes through releaseDeclinedOrder -> cancelBooking.
 * Before the fix, cancelBooking restored only capacity, so:
 *   - N declined keyless checkouts drained all N redemptions of a max_redemptions=N
 *     promo with zero completed sales; and
 *   - a guest's punch card was depleted on every post-order decline.
 *
 * This proves cancelBooking now reverses both: promo times_redeemed decrements
 * (floored at 0) and the punch-card holding's remaining_uses is restored (and a
 * DEPLETED holding flips back to ACTIVE).
 *
 * Skips without DATABASE_URL. Creates disposable fixtures against the seeded LSRA
 * tenant and deletes everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { createBooking, cancelBooking } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'fail02-restore-itest@example.com';
const PROMO_CODE = 'ITEST-FAIL02';
const PUNCHES_TOTAL = 5;

let activityId = '';
let rateId = '';
let qty = 1;
let timeslotId = '';
let promoId = '';
let membershipId = '';
let holdingId = '';
let customerId = '';
const createdOrderIds: string[] = [];

describe.skipIf(!HAS_DB)('fail-02: release restores promo + punch consumption', () => {
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
        activity_id: true,
        activity: { select: { min_participants: true, max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');
    activityId = rate.activity_id;
    rateId = rate.id;
    qty = rate.activity.min_participants;

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.promoCode.deleteMany({ where: { operator_id: OP, code: PROMO_CODE } });

    const db = forOperator(OP);

    const promo = await db.promoCode.create({
      data: {
        operator_id: OP,
        code: PROMO_CODE,
        name: 'fail-02 restore test promo',
        type: 'ONE_CODE',
        discount_type: 'PERCENT',
        discount_value: 10,
        is_active: true,
        // Single redemption: this is the abuse the bug enabled — one declined
        // checkout would have permanently consumed it.
        max_redemptions: 1,
        activity_ids: [],
      },
      select: { id: true },
    });
    promoId = promo.id;

    const slot = await db.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000),
        capacity_total: rate.activity.max_participants,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    timeslotId = slot.id;

    // A punch-card membership product + a holding for our guest with a known count.
    const membership = await db.membership.create({
      data: {
        operator_id: OP,
        name: 'fail-02 punch card',
        kind: 'PUNCH_CARD',
        discount_type: 'PERCENT',
        discount_value: 15,
        is_active: true,
        total_uses: PUNCHES_TOTAL,
      },
      select: { id: true },
    });
    membershipId = membership.id;

    const customer = await db.customer.create({
      data: { operator_id: OP, first_name: 'Fail02', last_name: 'Restore', email: TEST_EMAIL },
      select: { id: true },
    });
    customerId = customer.id;

    const holding = await db.customerMembership.create({
      data: {
        operator_id: OP,
        membership_id: membershipId,
        customer_id: customerId,
        status: 'ACTIVE',
        remaining_uses: PUNCHES_TOTAL,
      },
      select: { id: true },
    });
    holdingId = holding.id;
  });

  afterAll(async () => {
    if (createdOrderIds.length)
      await adminPrisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    if (holdingId) await adminPrisma.customerMembership.deleteMany({ where: { id: holdingId } });
    if (membershipId) await adminPrisma.membership.deleteMany({ where: { id: membershipId } });
    if (timeslotId) await adminPrisma.timeslot.deleteMany({ where: { id: timeslotId } });
    if (promoId) await adminPrisma.promoCode.deleteMany({ where: { id: promoId } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  it('decrements promo times_redeemed when a booking is released', async () => {
    const order = await createBooking(
      OP,
      {
        activityId,
        rateId,
        timeslotId,
        quantity: qty,
        customer: { first_name: 'Fail02', last_name: 'Promo', email: TEST_EMAIL },
        participants: [],
        promoCode: PROMO_CODE,
      },
      { channel: 'CUSTOMER' },
    );
    createdOrderIds.push(order.id);

    const afterCreate = await adminPrisma.promoCode.findUniqueOrThrow({
      where: { id: promoId },
      select: { times_redeemed: true },
    });
    expect(afterCreate.times_redeemed).toBe(1);

    // Simulate the decline path: releaseDeclinedOrder cancels then deletes; the
    // reversal lives in cancelBooking, so exercise that (then the row is gone).
    await cancelBooking(OP, order.id, { actor: 'system', reason: 'fail-02 test decline' });

    const afterCancel = await adminPrisma.promoCode.findUniqueOrThrow({
      where: { id: promoId },
      select: { times_redeemed: true },
    });
    // Back to 0 — the single-redemption promo is reusable, not burned.
    expect(afterCancel.times_redeemed).toBe(0);
  });

  it('restores punch-card remaining_uses (and un-depletes) when a booking is released', async () => {
    // Drain the holding to exactly `qty` left so this booking depletes it to 0.
    await adminPrisma.customerMembership.update({
      where: { id: holdingId },
      data: { remaining_uses: qty, status: 'ACTIVE' },
    });

    const order = await createBooking(
      OP,
      {
        activityId,
        rateId,
        timeslotId,
        quantity: qty,
        // Same email -> same customer -> the punch-card holding prices + is spent.
        customer: { first_name: 'Fail02', last_name: 'Punch', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    createdOrderIds.push(order.id);

    const afterCreate = await adminPrisma.customerMembership.findUniqueOrThrow({
      where: { id: holdingId },
      select: { remaining_uses: true, status: true },
    });
    expect(afterCreate.remaining_uses).toBe(0);
    expect(afterCreate.status).toBe('DEPLETED');

    await cancelBooking(OP, order.id, { actor: 'system', reason: 'fail-02 test decline' });

    const afterCancel = await adminPrisma.customerMembership.findUniqueOrThrow({
      where: { id: holdingId },
      select: { remaining_uses: true, status: true },
    });
    // The spent punches are handed back and the holding is usable again.
    expect(afterCancel.remaining_uses).toBe(qty);
    expect(afterCancel.status).toBe('ACTIVE');
  });
});
