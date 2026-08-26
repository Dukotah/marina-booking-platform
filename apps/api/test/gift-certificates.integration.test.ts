/**
 * Gift certificates — live integration test against the seeded LSRA tenant.
 * Certificates move money and are SINGLE-USE, so we prove against real data that:
 *   - issuing creates an ACTIVE certificate with a unique GC- code and fixed value;
 *   - checkGiftCertificate reports validity/value for public checks;
 *   - redeeming applies min(value, order balance due), records a GIFT_CARD Payment,
 *     flips the certificate to REDEEMED, and updates the order's paid/balance;
 *   - a redeemed certificate can NEVER be reused (even with balance to spare);
 *   - a VOID certificate is rejected and leaves the order untouched;
 *   - an activity-scoped certificate is rejected on an order without that activity.
 *
 * Skips without DATABASE_URL. Cleans up everything it creates in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { createBooking } from '../src/services/booking.js';
import {
  issueGiftCertificate,
  checkGiftCertificate,
  redeemGiftCertificate,
  getGiftCertificateByCode,
  giftCertificateLiabilityCents,
  GiftCertificateError,
} from '../src/services/gift-certificates.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'giftcert-itest@example.com';

let activityId = '';
let rateId = '';
let qty = 1;
let slotCapacity = 1;
const createdOrderIds: string[] = [];
const createdCertIds: string[] = [];
const createdTimeslotIds: string[] = [];

describe.skipIf(!HAS_DB)('gift certificates (live, LSRA seed)', () => {
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
    slotCapacity = Math.max(rate.activity.max_participants, qty);

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await adminPrisma.order.deleteMany({ where: { id } });
    for (const id of createdCertIds) await adminPrisma.giftCertificate.deleteMany({ where: { id } });
    for (const id of createdTimeslotIds) await adminPrisma.timeslot.deleteMany({ where: { id } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  /** Each booking gets its own fresh timeslot so tests never exhaust shared capacity. */
  async function bookOne(email = TEST_EMAIL) {
    const slot = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 34 * 24 * 60 * 60 * 1000),
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
        customer: { first_name: 'Cert', last_name: 'Tester', email },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    createdOrderIds.push(order.id);
    return order;
  }

  it('issues an ACTIVE certificate with a unique GC- code and fixed value', async () => {
    const cert = await issueGiftCertificate(OP, { valueCents: 5000, purchaserEmail: TEST_EMAIL });
    createdCertIds.push(cert.id);
    expect(cert.status).toBe('ACTIVE');
    expect(cert.value_cents).toBe(5000);
    expect(cert.code).toMatch(/^GC-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const check = await checkGiftCertificate(OP, cert.code.toLowerCase()); // case-insensitive
    expect(check.valid).toBe(true);
    expect(check.valueCents).toBe(5000);
  });

  it('redeems once against an order and cannot be reused', async () => {
    const cert = await issueGiftCertificate(OP, { valueCents: 3000 });
    createdCertIds.push(cert.id);
    const order = await bookOne();
    const total = order.total_cents;
    expect(order.balance_due_cents).toBe(total);
    expect(total).toBeGreaterThan(3000); // seed rate exceeds the cert, so applied = full value

    const r = await redeemGiftCertificate(OP, { code: cert.code, orderId: order.id });
    expect(r.appliedCents).toBe(3000);
    expect(r.orderAmountPaidCents).toBe(3000);
    expect(r.orderBalanceDueCents).toBe(total - 3000);

    // A GIFT_CARD payment row exists summing to the applied value.
    const paid = await adminPrisma.payment.aggregate({
      where: { operator_id: OP, order_id: order.id, method: 'GIFT_CARD' },
      _sum: { amount_cents: true },
    });
    expect(paid._sum.amount_cents).toBe(3000);

    // Certificate is REDEEMED and records the order it was used on.
    const reloaded = await getGiftCertificateByCode(OP, cert.code);
    expect(reloaded!.status).toBe('REDEEMED');
    expect(reloaded!.redeemed_order_id).toBe(order.id);

    // Reuse is rejected.
    await expect(
      redeemGiftCertificate(OP, { code: cert.code, orderId: order.id }),
    ).rejects.toThrow(GiftCertificateError);
  });

  it('caps the applied amount at the order balance due (never over-applies)', async () => {
    // Certificate value far exceeds the order total → applied = order total only.
    const cert = await issueGiftCertificate(OP, { valueCents: 5_000_000 });
    createdCertIds.push(cert.id);
    const order = await bookOne();
    const total = order.total_cents;

    const r = await redeemGiftCertificate(OP, { code: cert.code, orderId: order.id });
    expect(r.appliedCents).toBe(total);
    expect(r.orderBalanceDueCents).toBe(0);
  });

  it('rejects a VOID certificate and leaves the order untouched', async () => {
    const cert = await issueGiftCertificate(OP, { valueCents: 4000 });
    createdCertIds.push(cert.id);
    await adminPrisma.giftCertificate.update({ where: { id: cert.id }, data: { status: 'VOID' } });
    const order = await bookOne();
    await expect(
      redeemGiftCertificate(OP, { code: cert.code, orderId: order.id }),
    ).rejects.toThrow(GiftCertificateError);
    const fresh = await adminPrisma.order.findUnique({
      where: { id: order.id },
      select: { amount_paid_cents: true },
    });
    expect(fresh!.amount_paid_cents).toBe(0);
  });

  it('rejects an activity-scoped certificate on an order missing that activity', async () => {
    // Scope the certificate to a DIFFERENT activity than the one booked.
    const other = await adminPrisma.activity.findFirst({
      where: { operator_id: OP, id: { not: activityId } },
      select: { id: true },
    });
    if (!other) return; // single-activity seed — nothing to assert.
    const cert = await issueGiftCertificate(OP, { valueCents: 2000, activityId: other.id });
    createdCertIds.push(cert.id);
    const order = await bookOne();
    await expect(
      redeemGiftCertificate(OP, { code: cert.code, orderId: order.id }),
    ).rejects.toThrow(GiftCertificateError);
  });

  it('reports outstanding certificate liability from ACTIVE values', async () => {
    const liability = await giftCertificateLiabilityCents(OP);
    expect(liability).toBeGreaterThanOrEqual(0);
  });
});
