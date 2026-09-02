/**
 * Reserve now, pay at the marina — live integration test against the seeded Lake
 * Sonoma (LSRA) tenant. Proves the money path for the reserve payment mode:
 *
 *   - a booking created with NO deposit and NO online charge (exactly what the
 *     reserve-mode checkout does: it skips submitPayment) lands with the FULL
 *     amount as balance_due, amount_paid = 0, and NO Payment row — i.e. a real
 *     reservation awaiting on-arrival payment;
 *   - staff collect that balance at the marina in CASH (no processor, pure ledger
 *     write) — the primary at-the-marina flow — zeroing the balance and writing a
 *     BALANCE_COLLECTED event;
 *   - the alternative post-trip CARD charge flow still works against a reserve
 *     order (a second reserve order is settled by card);
 *   - a reserve order can be checked in while it still owes a balance.
 *
 * SKIPS when DATABASE_URL is unset. Unlike the deposit test this needs NO deposit
 * on the activity (the seed default is pay-in-full / deposit 0), so nothing is
 * charged at booking. It creates disposable orders/timeslots/customers and cleans
 * them up so it never pollutes the seed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { calculatePricing, type PricingFee } from '@marina/core';
import { createBooking, collectBalance } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
// CASH collection never touches the processor; CARD does, so enable the simulator.
process.env.DEV_FAKE_PAYMENTS = 'true';

const OP = 'lsra';
const TEST_EMAIL = 'reserve-itest@example.com';

interface Fixture {
  activityId: string;
  rateId: string;
  ratePriceCents: number;
  minParticipants: number;
}

let fx: Fixture;
const createdOrderIds: string[] = [];
const createdTimeslotIds: string[] = [];

/** Server-side fees for the activity, shaped for @marina/core (mirrors booking.ts). */
async function loadFees(activityId: string): Promise<PricingFee[]> {
  const rows = await adminPrisma.fee.findMany({
    where: { operator_id: OP, enabled: true, OR: [{ activity_id: activityId }, { activity_id: null }] },
    select: { name: true, type: true, value: true },
  });
  return rows.map((f) => ({ name: f.name, type: f.type, value: f.value }));
}

/** A fresh, far-future timeslot so the reservation never collides with the seed. */
async function makeTimeslot(): Promise<string> {
  const db = forOperator(OP);
  const future = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);
  const slot = await db.timeslot.create({
    data: {
      operator_id: OP,
      activity_id: fx.activityId,
      datetime: future,
      capacity_total: 20,
      capacity_booked: 0,
      status: 'AVAILABLE',
    },
    select: { id: true },
  });
  createdTimeslotIds.push(slot.id);
  return slot.id;
}

/** Book without a deposit and without an online charge — the reserve-mode path. */
async function reserve(timeslotId: string) {
  const order = await createBooking(
    OP,
    {
      activityId: fx.activityId,
      rateId: fx.rateId,
      timeslotId,
      quantity: fx.minParticipants,
      customer: { first_name: 'Reserve', last_name: 'Booker', email: TEST_EMAIL },
      participants: [],
    },
    { channel: 'CUSTOMER', actor: 'reserve.integration.test' },
  );
  createdOrderIds.push(order.id);
  return order;
}

describe.skipIf(!HAS_DB)('reserve now, pay at the marina (live vs Postgres, LSRA seed)', () => {
  beforeAll(async () => {
    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true, deposit_percent: null },
      },
      select: {
        id: true,
        price_cents: true,
        activity_id: true,
        activity: { select: { min_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public pay-in-full rate found in the LSRA seed — run `pnpm db:seed`.');

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });

    fx = {
      activityId: rate.activity_id,
      rateId: rate.id,
      ratePriceCents: rate.price_cents,
      minParticipants: rate.activity.min_participants,
    };
  });

  afterAll(async () => {
    if (createdOrderIds.length)
      await adminPrisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    if (createdTimeslotIds.length)
      await adminPrisma.timeslot.deleteMany({ where: { id: { in: createdTimeslotIds } } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  it('creates a reservation with the full amount due and nothing charged online', async () => {
    const order = await reserve(await makeTimeslot());

    const expected = calculatePricing({
      items: [{ unitPriceCents: fx.ratePriceCents, quantity: fx.minParticipants }],
      fees: await loadFees(fx.activityId),
      promo: null,
      tipCents: 0,
    });

    // The whole total is owed at the marina; nothing was collected online.
    expect(order.total_cents).toBe(expected.totalCents);
    expect(order.amount_paid_cents).toBe(0);
    expect(order.balance_due_cents).toBe(expected.totalCents);
    expect(order.balance_due_cents).toBeGreaterThan(0);

    // No Payment row exists — a reservation, not a sale.
    const payments = await adminPrisma.payment.findMany({ where: { order_id: order.id } });
    expect(payments).toHaveLength(0);
  });

  it('can be checked in while it still owes a balance', async () => {
    const order = await reserve(await makeTimeslot());
    const item = await adminPrisma.orderItem.findFirst({ where: { order_id: order.id } });
    expect(item).not.toBeNull();

    // Staff check the guest in at the dock even though the balance is unpaid.
    await forOperator(OP).orderItem.update({
      where: { id: item!.id },
      data: { status: 'CHECKED_IN' },
    });

    const after = await adminPrisma.orderItem.findUnique({ where: { id: item!.id } });
    expect(after!.status).toBe('CHECKED_IN');
    const ord = await adminPrisma.order.findUnique({ where: { id: order.id } });
    expect(ord!.balance_due_cents).toBeGreaterThan(0);
  });

  it('collects the balance in CASH at the marina (no processor) and zeroes it', async () => {
    const order = await reserve(await makeTimeslot());
    const balanceBefore = order.balance_due_cents;
    expect(balanceBefore).toBeGreaterThan(0);

    const result = await collectBalance(OP, order.id, {
      actor: 'reserve.integration.test',
      method: 'CASH',
    });

    expect(result.chargedCents).toBe(balanceBefore);
    expect(result.balanceDueCents).toBe(0);
    expect(result.amountPaidCents).toBe(order.total_cents);

    const after = await adminPrisma.order.findUnique({ where: { id: order.id } });
    expect(after!.balance_due_cents).toBe(0);
    expect(after!.amount_paid_cents).toBe(after!.total_cents);

    // Exactly one CASH payment, and a BALANCE_COLLECTED event.
    const payments = await adminPrisma.payment.findMany({ where: { order_id: order.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.method).toBe('CASH');
    expect(payments[0]!.amount_cents).toBe(balanceBefore);

    const events = await adminPrisma.orderEvent.findMany({ where: { order_id: order.id } });
    expect(events.some((e) => e.type === 'BALANCE_COLLECTED')).toBe(true);
  });

  it('also settles a reserve order by CARD at check-in (post-trip charge path)', async () => {
    const order = await reserve(await makeTimeslot());
    const balanceBefore = order.balance_due_cents;

    const result = await collectBalance(OP, order.id, {
      actor: 'reserve.integration.test',
      method: 'CARD',
    });

    expect(result.chargedCents).toBe(balanceBefore);
    expect(result.balanceDueCents).toBe(0);

    const payments = await adminPrisma.payment.findMany({ where: { order_id: order.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.method).toBe('CARD');
    expect(payments[0]!.status).toBe('PAID');

    const after = await adminPrisma.order.findUnique({ where: { id: order.id } });
    expect(after!.balance_due_cents).toBe(0);
    expect(after!.amount_paid_cents).toBe(after!.total_cents);
  });
});
