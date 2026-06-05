/**
 * Gift-card management — live integration test against the seeded LSRA tenant on
 * Neon. Covers the staff controls for a stored-value instrument that has no order
 * behind it: manual balance correction (the previously-unwired `ADJUST` ledger
 * type) and void / reactivate. Gift cards are real money, so we verify against real
 * data that:
 *   - a positive adjustment credits the card and writes a signed +ADJUST entry;
 *   - a negative adjustment corrects it down with a signed −ADJUST entry;
 *   - an adjustment that would drive the balance below zero is refused, balance kept;
 *   - voiding freezes the card (balance preserved) and blocks redeem + adjust;
 *   - reactivating un-freezes it so the preserved balance can be spent again;
 *   - the HTTP adjust endpoint is gated at the `order:refund` tier (a STAFF-role
 *     identity with only `order:write` gets 403; no identity gets 401);
 *   - through all of it the ledger keeps summing to the card's balance.
 *
 * Skips without DATABASE_URL. Creates its own gift card + a STAFF-role staff row
 * (alongside the dev-owner OWNER row) and deletes everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { app } from '../src/app.js';
import {
  issueGiftCard,
  redeemGiftCard,
  adjustGiftCardBalance,
  voidGiftCard,
  reactivateGiftCard,
} from '../src/services/giftcards.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const STAFF_ID = 'dev-staff-mgmt-itest'; // a STAFF-role identity: order:write but NOT order:refund

let cardId = '';
let cardCode = '';
let createdOwner = false;
let createdStaff = false;

/** Sum the signed ledger; it must always equal the card's authoritative balance. */
async function ledgerSum(id: string): Promise<number> {
  const agg = await adminPrisma.giftCardTransaction.aggregate({
    where: { gift_card_id: id },
    _sum: { amount_cents: true },
  });
  return agg._sum.amount_cents ?? 0;
}

describe.skipIf(!HAS_DB)('gift-card management (live vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    const loc = await adminPrisma.location.findFirst({
      where: { operator_id: OP },
      select: { id: true },
    });

    // dev-owner (OWNER → has order:refund) for the happy-path HTTP calls.
    const owner = await adminPrisma.staffMember.findFirst({
      where: { operator_id: OP, auth_user_id: 'dev-owner' },
      select: { id: true },
    });
    if (!owner) {
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
      createdOwner = true;
    }

    // A STAFF-role member: has order:write but NOT order:refund → must get 403.
    await adminPrisma.staffMember.create({
      data: {
        operator_id: OP,
        auth_user_id: STAFF_ID,
        name: 'Dev Staff',
        email: 'dev-staff-mgmt@example.com',
        role: 'STAFF',
        is_active: true,
        locations: loc ? { create: { location_id: loc.id } } : undefined,
      },
    });
    createdStaff = true;

    const card = await issueGiftCard(OP, { amountCents: 10_000 }, { actor: 'itest' }); // $100
    cardId = card.id;
    cardCode = card.code;
  });

  afterAll(async () => {
    if (cardId) await adminPrisma.giftCard.deleteMany({ where: { id: cardId } }); // cascades to txns
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: STAFF_ID } });
    }
    if (createdOwner) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
    await adminPrisma.$disconnect();
  });

  it('adjusts the balance up with a signed +ADJUST ledger entry', async () => {
    const result = await adjustGiftCardBalance(OP, cardCode, 2_500, 'Goodwill credit', { actor: 'itest' });
    expect(result.balanceCents).toBe(12_500);
    expect(result.deltaCents).toBe(2_500);

    const entry = await adminPrisma.giftCardTransaction.findFirst({
      where: { gift_card_id: cardId, type: 'ADJUST' },
      orderBy: { created_at: 'desc' },
    });
    expect(entry!.amount_cents).toBe(2_500);
    expect(entry!.balance_after_cents).toBe(12_500);
    expect(entry!.note).toBe('Goodwill credit');
    expect(await ledgerSum(cardId)).toBe(12_500);
  });

  it('adjusts the balance down with a signed −ADJUST ledger entry', async () => {
    const result = await adjustGiftCardBalance(OP, cardCode, -5_000, 'Correcting over-issue', { actor: 'itest' });
    expect(result.balanceCents).toBe(7_500);

    const card = await adminPrisma.giftCard.findUnique({ where: { id: cardId } });
    expect(card!.balance_cents).toBe(7_500);
    expect(await ledgerSum(cardId)).toBe(7_500);
  });

  it('refuses an adjustment that would drive the balance below zero, balance untouched', async () => {
    await expect(
      adjustGiftCardBalance(OP, cardCode, -1_000_000, 'oops', { actor: 'itest' }),
    ).rejects.toMatchObject({ code: 'ADJUST_BELOW_ZERO' });

    const card = await adminPrisma.giftCard.findUnique({ where: { id: cardId } });
    expect(card!.balance_cents).toBe(7_500); // unchanged
  });

  it('refuses an empty-reason adjustment', async () => {
    await expect(
      adjustGiftCardBalance(OP, cardCode, 100, '   ', { actor: 'itest' }),
    ).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
  });

  it('staff HTTP adjust endpoint (order:refund via dev-owner) corrects the balance', async () => {
    const res = await app.request(`/api/giftcards/${cardCode}/adjust`, {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner', 'content-type': 'application/json' },
      body: JSON.stringify({ deltaCents: -500, reason: 'POS keying error' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balanceCents: number; deltaCents: number };
    expect(body.balanceCents).toBe(7_000);
    expect(body.deltaCents).toBe(-500);
  });

  it('HTTP adjust is gated at order:refund — a STAFF-role identity gets 403', async () => {
    const res = await app.request(`/api/giftcards/${cardCode}/adjust`, {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': STAFF_ID, 'content-type': 'application/json' },
      body: JSON.stringify({ deltaCents: 1_000, reason: 'should be blocked' }),
    });
    expect(res.status).toBe(403);

    const card = await adminPrisma.giftCard.findUnique({ where: { id: cardId } });
    expect(card!.balance_cents).toBe(7_000); // untouched by the rejected call
  });

  it('HTTP void requires a staff identity (401 without the shim)', async () => {
    const res = await app.request(`/api/giftcards/${cardCode}/void`, {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('voids the card: balance preserved, marker entry written, redeem + adjust blocked', async () => {
    const voided = await voidGiftCard(OP, cardCode, { reason: 'Lost card', actor: 'itest' });
    expect(voided.is_active).toBe(false);
    expect(voided.balance_cents).toBe(7_000); // value preserved, not destroyed

    const marker = await adminPrisma.giftCardTransaction.findFirst({
      where: { gift_card_id: cardId, type: 'ADJUST' },
      orderBy: { created_at: 'desc' },
    });
    expect(marker!.amount_cents).toBe(0); // zero-amount audit marker
    expect(marker!.balance_after_cents).toBe(7_000);
    expect(marker!.note).toBe('Voided: Lost card');
    expect(await ledgerSum(cardId)).toBe(7_000); // marker leaves the sum unchanged

    // A frozen card can no longer be spent or corrected.
    await expect(redeemGiftCard(OP, cardCode, 100, { actor: 'itest' })).rejects.toMatchObject({
      code: 'GIFT_CARD_INACTIVE',
    });
    await expect(
      adjustGiftCardBalance(OP, cardCode, 100, 'nope', { actor: 'itest' }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_INACTIVE' });
    // Double-void is refused.
    await expect(voidGiftCard(OP, cardCode, { actor: 'itest' })).rejects.toMatchObject({
      code: 'ALREADY_VOIDED',
    });
  });

  it('reactivates the card so the preserved balance can be spent again', async () => {
    const reactivated = await reactivateGiftCard(OP, cardCode, { actor: 'itest' });
    expect(reactivated.is_active).toBe(true);
    expect(reactivated.balance_cents).toBe(7_000);

    // Double-reactivate is refused.
    await expect(reactivateGiftCard(OP, cardCode, { actor: 'itest' })).rejects.toMatchObject({
      code: 'ALREADY_ACTIVE',
    });

    // Now spendable again.
    const result = await redeemGiftCard(OP, cardCode, 1_000, { actor: 'itest' });
    expect(result.balanceCents).toBe(6_000);
    expect(await ledgerSum(cardId)).toBe(6_000); // ledger still reconciles end-to-end
  });
});
