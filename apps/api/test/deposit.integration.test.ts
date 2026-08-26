/**
 * Deposits / pay-balance-later — live integration test against the seeded Lake
 * Sonoma (LSRA) tenant. Exercises the real money path end-to-end:
 *   - createBooking takes only the DEPOSIT when an activity sets deposit_percent
 *     (amount_paid = deposit, balance_due = total - deposit), writes a matching
 *     PAID Payment row and a DEPOSIT OrderEvent;
 *   - collectBalance charges the remaining balance, zeroes balance_due, writes a
 *     second Payment + a BALANCE_COLLECTED OrderEvent, leaving the order paid in
 *     full;
 *   - the deposit + balance always sum back to the order total.
 *
 * SKIPS when DATABASE_URL is unset. Requires DEV_FAKE_PAYMENTS=true (the simulated
 * processor) so the charge succeeds with no Stripe account. It temporarily sets a
 * deposit_percent on a seed activity and restores it in afterAll, and cleans up the
 * disposable order/timeslot/customer it creates, so it never pollutes the seed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { calculatePricing, computeDepositCents, type PricingFee } from '@marina/core';
import { createBooking, collectBalance } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
// The deposit path charges via the (fake) processor — force it on for this test.
process.env.DEV_FAKE_PAYMENTS = 'true';

const OP = 'lsra';
const TEST_EMAIL = 'deposit-itest@example.com';
const DEPOSIT_PERCENT = 25;

interface Fixture {
  activityId: string;
  rateId: string;
  ratePriceCents: number;
  minParticipants: number;
  timeslotId: string;
  originalDepositPercent: number | null;
}

let fx: Fixture;
let createdOrderId: string | null = null;

/** Server-side fees for the activity, shaped for @marina/core (mirrors booking.ts). */
async function loadFees(activityId: string): Promise<PricingFee[]> {
  const rows = await adminPrisma.fee.findMany({
    where: { operator_id: OP, enabled: true, OR: [{ activity_id: activityId }, { activity_id: null }] },
    select: { name: true, type: true, value: true },
  });
  return rows.map((f) => ({ name: f.name, type: f.type, value: f.value }));
}

describe.skipIf(!HAS_DB)('deposits (live vs Postgres, LSRA seed)', () => {
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
        activity: { select: { min_participants: true, deposit_percent: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });

    // Turn on a deposit for this activity for the duration of the test.
    await adminPrisma.activity.update({
      where: { id: rate.activity_id },
      data: { deposit_percent: DEPOSIT_PERCENT },
    });

    const db = forOperator(OP);
    const future = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    const slot = await db.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: rate.activity_id,
        datetime: future,
        capacity_total: 20,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });

    fx = {
      activityId: rate.activity_id,
      rateId: rate.id,
      ratePriceCents: rate.price_cents,
      minParticipants: rate.activity.min_participants,
      timeslotId: slot.id,
      originalDepositPercent: rate.activity.deposit_percent,
    };
  });

  afterAll(async () => {
    if (createdOrderId) await adminPrisma.order.deleteMany({ where: { id: createdOrderId } });
    if (fx?.timeslotId) await adminPrisma.timeslot.deleteMany({ where: { id: fx.timeslotId } });
    if (fx?.activityId) {
      await adminPrisma.activity.update({
        where: { id: fx.activityId },
        data: { deposit_percent: fx.originalDepositPercent },
      });
    }
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  it('takes only the deposit at booking and splits the ledger', async () => {
    const qty = fx.minParticipants;
    const order = await createBooking(
      OP,
      {
        activityId: fx.activityId,
        rateId: fx.rateId,
        timeslotId: fx.timeslotId,
        quantity: qty,
        customer: { first_name: 'Deposit', last_name: 'Booker', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER', actor: 'deposit.integration.test' },
    );
    createdOrderId = order.id;

    const expected = calculatePricing({
      items: [{ unitPriceCents: fx.ratePriceCents, quantity: qty }],
      fees: await loadFees(fx.activityId),
      promo: null,
      tipCents: 0,
    });
    const expectedDeposit = computeDepositCents(expected.totalCents, DEPOSIT_PERCENT);

    // Ledger split: deposit paid now, remainder due; the two sum back to the total.
    expect(order.total_cents).toBe(expected.totalCents);
    expect(order.amount_paid_cents).toBe(expectedDeposit);
    expect(order.balance_due_cents).toBe(expected.totalCents - expectedDeposit);
    expect(order.amount_paid_cents + order.balance_due_cents).toBe(order.total_cents);

    // A matching PAID Payment row for the deposit amount was written.
    const payments = await adminPrisma.payment.findMany({ where: { order_id: order.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.amount_cents).toBe(expectedDeposit);
    expect(payments[0]!.status).toBe('PAID');

    // A DEPOSIT audit event was recorded.
    const events = await adminPrisma.orderEvent.findMany({ where: { order_id: order.id } });
    expect(events.some((e) => e.type === 'DEPOSIT')).toBe(true);
  });

  it('collectBalance charges the remainder and zeroes the balance', async () => {
    expect(createdOrderId).not.toBeNull();
    const before = await adminPrisma.order.findUnique({ where: { id: createdOrderId! } });
    const balanceBefore = before!.balance_due_cents;
    expect(balanceBefore).toBeGreaterThan(0);

    const result = await collectBalance(OP, createdOrderId!, {
      actor: 'deposit.integration.test',
      method: 'CARD',
    });

    expect(result.chargedCents).toBe(balanceBefore);
    expect(result.balanceDueCents).toBe(0);
    expect(result.amountPaidCents).toBe(before!.total_cents);

    const after = await adminPrisma.order.findUnique({ where: { id: createdOrderId! } });
    expect(after!.balance_due_cents).toBe(0);
    expect(after!.amount_paid_cents).toBe(after!.total_cents);

    // Now two payments (deposit + balance), and a BALANCE_COLLECTED event.
    const payments = await adminPrisma.payment.findMany({ where: { order_id: createdOrderId! } });
    expect(payments).toHaveLength(2);
    const paidSum = payments.reduce((s, p) => s + p.amount_cents, 0);
    expect(paidSum).toBe(after!.total_cents);

    const events = await adminPrisma.orderEvent.findMany({ where: { order_id: createdOrderId! } });
    expect(events.some((e) => e.type === 'BALANCE_COLLECTED')).toBe(true);
  });

  it('refuses to collect a balance twice (nothing left due)', async () => {
    await expect(
      collectBalance(OP, createdOrderId!, { actor: 'deposit.integration.test' }),
    ).rejects.toThrow(/no outstanding balance/i);
  });
});
