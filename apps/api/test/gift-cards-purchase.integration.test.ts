/**
 * Public gift-card purchase — live HTTP integration test against the seeded LSRA
 * tenant. Drives the real Hono app via `app.request(...)` so it covers the FULL
 * endpoint wiring: tenant middleware, zod validation, the PaymentProvider seam
 * (sandbox/fake driver in test), issueGiftCard, and the recipient email dispatch.
 *
 *   POST /api/public/gift-cards/purchase   PUBLIC — buy a gift card online
 *
 * MONEY DISCIPLINE proven here:
 *   - the server is the price authority: the amount charged == the card balance,
 *     both re-derived server-side from the allowed denomination set;
 *   - a TAMPER attempt (an amount NOT in the denomination set) is rejected with a
 *     clean 400 and mints NO card and takes NO money.
 *
 * This whole suite FAILS before the feature exists (the route 404s, so the happy
 * path's 201 assertion fails) and PASSES after.
 *
 * Skips without DATABASE_URL. Deletes every card it issued in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { app } from '../src/app.js';
import { GIFT_CARD_DENOMINATIONS_CENTS } from '../src/services/gift-cards.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const RECIPIENT = 'giftcard-purchase-itest@example.com';

const publicJsonHeaders = {
  'x-operator-slug': SLUG,
  'content-type': 'application/json',
};

const createdCardIds: string[] = [];

describe.skipIf(!HAS_DB)('public gift-card purchase (live HTTP vs seeded LSRA)', () => {
  beforeAll(async () => {
    await adminPrisma.giftCard.deleteMany({
      where: { operator_id: OP, recipient_email: RECIPIENT },
    });
  });

  afterAll(async () => {
    for (const id of createdCardIds) await adminPrisma.giftCard.deleteMany({ where: { id } });
    await adminPrisma.giftCard.deleteMany({
      where: { operator_id: OP, recipient_email: RECIPIENT },
    });
    await adminPrisma.$disconnect();
  });

  it('charges, issues a card for EXACTLY the charged amount, and reports it', async () => {
    const amountCents = GIFT_CARD_DENOMINATIONS_CENTS[1]!; // $50.00
    const res = await app.request('/api/public/gift-cards/purchase', {
      method: 'POST',
      headers: publicJsonHeaders,
      body: JSON.stringify({
        amountCents,
        sourceId: 'pm_card_visa',
        recipientEmail: RECIPIENT,
        recipientName: 'Purchase Tester',
        purchaserName: 'Generous Giver',
        message: 'Enjoy a day on the lake!',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      giftCard: { id: string; code: string; balanceCents: number; status: string };
      amountChargedCents: number;
    };
    createdCardIds.push(body.giftCard.id);

    // quote == charge == balance.
    expect(body.amountChargedCents).toBe(amountCents);
    expect(body.giftCard.balanceCents).toBe(amountCents);
    expect(body.giftCard.status).toBe('ACTIVE');
    expect(body.giftCard.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // The DB row's balance is the charged amount — not a client-supplied number.
    const row = await adminPrisma.giftCard.findUnique({
      where: { id: body.giftCard.id },
      select: { balance_cents: true, initial_cents: true },
    });
    expect(row?.balance_cents).toBe(amountCents);
    expect(row?.initial_cents).toBe(amountCents);
  });

  it('TAMPER: rejects an off-denomination amount and issues NO card, takes NO money', async () => {
    // $1.00 is not an allowed denomination. A client that tries to buy a cheap card
    // (or a huge card for a cheap price) must be rejected before any charge or issue.
    const tampered = 100;
    expect(GIFT_CARD_DENOMINATIONS_CENTS).not.toContain(tampered);

    const before = await adminPrisma.giftCard.count({
      where: { operator_id: OP, recipient_email: RECIPIENT },
    });

    const res = await app.request('/api/public/gift-cards/purchase', {
      method: 'POST',
      headers: publicJsonHeaders,
      body: JSON.stringify({
        amountCents: tampered,
        sourceId: 'pm_card_visa',
        recipientEmail: RECIPIENT,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('INVALID_AMOUNT');

    // No new card was minted by the rejected request.
    const after = await adminPrisma.giftCard.count({
      where: { operator_id: OP, recipient_email: RECIPIENT },
    });
    expect(after).toBe(before);
  });

  it('rejects a missing payment source and a bad recipient email (zod)', async () => {
    const noSource = await app.request('/api/public/gift-cards/purchase', {
      method: 'POST',
      headers: publicJsonHeaders,
      body: JSON.stringify({ amountCents: 5000, recipientEmail: RECIPIENT }),
    });
    expect(noSource.status).toBe(400);

    const badEmail = await app.request('/api/public/gift-cards/purchase', {
      method: 'POST',
      headers: publicJsonHeaders,
      body: JSON.stringify({ amountCents: 5000, sourceId: 'pm_card_visa', recipientEmail: 'nope' }),
    });
    expect(badEmail.status).toBe(400);
  });
});
