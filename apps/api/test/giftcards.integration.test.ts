/**
 * Gift cards — live integration test against the seeded LSRA tenant on Neon. Gift
 * cards are stored value (real money), so we verify against real data that:
 *   - issueGiftCard loads the balance and writes an ISSUE ledger entry whose
 *     running balance matches;
 *   - redeemGiftCard draws the balance down, records a signed REDEEM ledger entry,
 *     and reports the amount applied;
 *   - an over-redemption is refused and leaves the balance untouched;
 *   - the public HTTP balance check returns the current balance by full code;
 *   - the staff HTTP redeem endpoint (dev-staff shim) draws the card down.
 *
 * Skips without DATABASE_URL. Creates its own gift card (+ the dev-owner staff row
 * if missing) and deletes everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { app } from '../src/app.js';
import { issueGiftCard, redeemGiftCard, GiftCardError } from '../src/services/giftcards.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';

let cardId = '';
let cardCode = '';
let createdStaff = false;

describe.skipIf(!HAS_DB)('gift cards (live vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    // The staff HTTP endpoints resolve `x-dev-staff-id: dev-owner` to this row.
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

    const card = await issueGiftCard(
      OP,
      {
        amountCents: 10_000, // $100
        purchaserName: 'Gift Buyer',
        recipientName: 'Lucky Recipient',
        message: 'Happy birthday!',
      },
      { actor: 'itest' },
    );
    cardId = card.id;
    cardCode = card.code;
  });

  afterAll(async () => {
    if (cardId) await adminPrisma.giftCard.deleteMany({ where: { id: cardId } }); // cascades to transactions
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
    await adminPrisma.$disconnect();
  });

  it('issues a card with a full balance and an ISSUE ledger entry', async () => {
    const card = await adminPrisma.giftCard.findUnique({ where: { id: cardId } });
    expect(card!.initial_cents).toBe(10_000);
    expect(card!.balance_cents).toBe(10_000);
    expect(card!.is_active).toBe(true);
    expect(card!.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/); // unambiguous grouped code

    const txns = await adminPrisma.giftCardTransaction.findMany({ where: { gift_card_id: cardId } });
    expect(txns).toHaveLength(1);
    expect(txns[0]!.type).toBe('ISSUE');
    expect(txns[0]!.amount_cents).toBe(10_000);
    expect(txns[0]!.balance_after_cents).toBe(10_000);
  });

  it('redeems part of the balance and records a signed REDEEM entry', async () => {
    const result = await redeemGiftCard(OP, cardCode, 2_500, { actor: 'itest', note: 'POS sale' });
    expect(result.amountAppliedCents).toBe(2_500);
    expect(result.balanceCents).toBe(7_500);

    const card = await adminPrisma.giftCard.findUnique({ where: { id: cardId } });
    expect(card!.balance_cents).toBe(7_500);

    const redeem = await adminPrisma.giftCardTransaction.findFirst({
      where: { gift_card_id: cardId, type: 'REDEEM' },
      orderBy: { created_at: 'desc' },
    });
    expect(redeem!.amount_cents).toBe(-2_500); // signed: draws the balance down
    expect(redeem!.balance_after_cents).toBe(7_500);
  });

  it('refuses an over-redemption and leaves the balance untouched', async () => {
    await expect(
      redeemGiftCard(OP, cardCode, 1_000_000, { actor: 'itest' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });

    const card = await adminPrisma.giftCard.findUnique({ where: { id: cardId } });
    expect(card!.balance_cents).toBe(7_500); // unchanged
  });

  it('public HTTP balance check returns the current balance by code', async () => {
    const res = await app.request(`/api/giftcards/${cardCode}/balance`, {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balanceCents: number; isActive: boolean; expired: boolean };
    expect(body.balanceCents).toBe(7_500);
    expect(body.isActive).toBe(true);
    expect(body.expired).toBe(false);
  });

  it('staff HTTP redeem endpoint draws the card down', async () => {
    const res = await app.request(`/api/giftcards/${cardCode}/redeem`, {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner', 'content-type': 'application/json' },
      body: JSON.stringify({ amountCents: 2_500 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balanceCents: number };
    expect(body.balanceCents).toBe(5_000);

    const card = await adminPrisma.giftCard.findUnique({ where: { id: cardId } });
    expect(card!.balance_cents).toBe(5_000);
  });

  it('staff HTTP redeem requires a staff identity (401 without the shim)', async () => {
    const res = await app.request(`/api/giftcards/${cardCode}/redeem`, {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ amountCents: 100 }),
    });
    expect(res.status).toBe(401);
  });
});
