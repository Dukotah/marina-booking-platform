/**
 * Gift card service — issue, look up, and redeem prepaid gift cards.
 *
 * A gift card holds a balance in integer cents. Redemption against an order
 * records a Payment (method GIFT_CARD) that references the card, decrements the
 * balance, and updates the order's amount_paid / balance_due — the exact same
 * settle-against-order pattern the Stripe/POS payment paths use. All balance
 * mutation runs inside a single tenant-scoped transaction (`withTenant`) so RLS
 * scopes every row and concurrent redemptions can't oversell a card.
 *
 * Gift-card liability (money owed to holders) = SUM(balance_cents) of ACTIVE cards.
 */

import { randomInt } from 'node:crypto';
import { Prisma, forOperator, withTenant, type GiftCard } from '@marina/database';
import { formatUSD } from '@marina/core';

/** A typed, user-facing failure that route handlers map to a clean HTTP status. */
export class GiftCardError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'GiftCardError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

// Unambiguous alphabet — no 0/O/1/I/L to avoid read/transcription errors.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomSegment(length = 4): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** A human-typable code like `A7QK-9MTX-3RJP`. */
function generateCode(): string {
  return `${randomSegment()}-${randomSegment()}-${randomSegment()}`;
}

/** Normalize user-entered codes (case + surrounding whitespace) for lookup. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export interface IssueGiftCardInput {
  initialCents: number;
  purchaserEmail?: string;
  recipientName?: string;
  recipientEmail?: string;
  message?: string;
  /** Optional expiry; ACTIVE cards with a past expiry are treated as EXPIRED on use. */
  expiresAt?: Date;
}

/**
 * Issue a new ACTIVE gift card with a unique code and the given starting balance.
 * Retries on the (rare) code collision against the per-operator unique index.
 */
export async function issueGiftCard(
  operatorId: string,
  input: IssueGiftCardInput,
): Promise<GiftCard> {
  if (!Number.isInteger(input.initialCents) || input.initialCents <= 0) {
    throw new GiftCardError('INVALID_AMOUNT', 'Gift card amount must be a positive whole number of cents.');
  }
  const db = forOperator(operatorId);

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      return await db.giftCard.create({
        data: {
          operator_id: operatorId,
          code,
          initial_cents: input.initialCents,
          balance_cents: input.initialCents,
          status: 'ACTIVE',
          purchaser_email: input.purchaserEmail ?? null,
          recipient_name: input.recipientName ?? null,
          recipient_email: input.recipientEmail ?? null,
          message: input.message ?? null,
          expires_at: input.expiresAt ?? null,
        },
      });
    } catch (err) {
      // Unique-constraint collision on (operator_id, code) → try a fresh code.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
  }
  throw new GiftCardError('CODE_COLLISION', 'Could not allocate a unique gift card code; please retry.', 500);
}

// ---------------------------------------------------------------------------
// Online purchase — price authority
// ---------------------------------------------------------------------------

/**
 * The denominations a card may be bought for online, in integer cents. The server
 * is the price authority: a public purchase may only name an amount from THIS set,
 * so a tampered client can never buy a $500 card for $1. The one amount it names is
 * BOTH the amount charged and the value loaded onto the card — quote == charge ==
 * balance, by construction, because they are the same number re-derived here.
 */
export const GIFT_CARD_DENOMINATIONS_CENTS: readonly number[] = [
  2_500, 5_000, 10_000, 15_000, 20_000, 25_000, 50_000,
];

/**
 * Re-derive the server-authoritative purchase amount from a client-requested
 * amount. Returns the amount ONLY if it exactly matches an allowed denomination;
 * throws otherwise. This is the single choke point that makes "amount charged ==
 * card value" impossible to subvert from the client.
 */
export function resolvePurchaseAmountCents(requestedCents: unknown): number {
  if (!Number.isInteger(requestedCents) || (requestedCents as number) <= 0) {
    throw new GiftCardError('INVALID_AMOUNT', 'Choose a valid gift card amount.');
  }
  const amount = requestedCents as number;
  if (!GIFT_CARD_DENOMINATIONS_CENTS.includes(amount)) {
    throw new GiftCardError(
      'INVALID_AMOUNT',
      'That gift card amount is not available. Pick one of the listed amounts.',
    );
  }
  return amount;
}

// ---------------------------------------------------------------------------
// Lookup / validate (public balance check + checkout preview)
// ---------------------------------------------------------------------------

export interface GiftCardCheck {
  valid: boolean;
  code: string;
  balanceCents: number;
  status: GiftCard['status'];
  /** Present when valid is false. */
  reason?: string;
}

/** Load a card by its (normalized) code within the operator. */
export async function getGiftCardByCode(
  operatorId: string,
  code: string,
): Promise<GiftCard | null> {
  const db = forOperator(operatorId);
  return db.giftCard.findUnique({
    where: { operator_id_code: { operator_id: operatorId, code: normalizeCode(code) } },
  });
}

/** Is this card usable right now? Safe to expose publicly (balance check). */
export async function checkGiftCard(operatorId: string, code: string): Promise<GiftCardCheck> {
  const card = await getGiftCardByCode(operatorId, code);
  if (!card) {
    return { valid: false, code: normalizeCode(code), balanceCents: 0, status: 'VOID', reason: 'No gift card with that code.' };
  }
  const base = { code: card.code, balanceCents: card.balance_cents, status: card.status };
  if (card.status === 'VOID') return { valid: false, ...base, reason: 'This gift card has been voided.' };
  if (card.status === 'REDEEMED' || card.balance_cents <= 0)
    return { valid: false, ...base, reason: 'This gift card has no remaining balance.' };
  if (card.expires_at && card.expires_at.getTime() < Date.now())
    return { valid: false, ...base, status: 'EXPIRED', reason: 'This gift card has expired.' };
  return { valid: true, ...base };
}

// ---------------------------------------------------------------------------
// Redeem (settle against an order)
// ---------------------------------------------------------------------------

export interface RedeemGiftCardInput {
  code: string;
  orderId: string;
  /** Cap the amount to apply; defaults to the order's full outstanding balance. */
  amountCents?: number;
  /** Audit actor (e.g. 'customer' or a staff id/email). */
  actor?: string;
}

export interface RedeemGiftCardResult {
  giftCardId: string;
  code: string;
  /** Cents actually applied to the order this redemption. */
  appliedCents: number;
  /** Remaining balance on the card after redemption. */
  cardBalanceCents: number;
  cardStatus: GiftCard['status'];
  /** Order totals after applying the gift card. */
  orderAmountPaidCents: number;
  orderBalanceDueCents: number;
}

/**
 * Apply a gift card to an order. Applies min(card balance, requested amount,
 * order balance due). Atomic: reloads the card + order inside the transaction so
 * two concurrent redemptions can't spend the same balance twice.
 */
export async function redeemGiftCard(
  operatorId: string,
  input: RedeemGiftCardInput,
): Promise<RedeemGiftCardResult> {
  const normalized = normalizeCode(input.code);

  return withTenant(operatorId, async (tx) => {
    const card = await tx.giftCard.findUnique({
      where: { operator_id_code: { operator_id: operatorId, code: normalized } },
    });
    if (!card) throw new GiftCardError('NOT_FOUND', 'No gift card with that code.', 404);
    if (card.status === 'VOID') throw new GiftCardError('VOID', 'This gift card has been voided.');
    if (card.expires_at && card.expires_at.getTime() < Date.now()) {
      if (card.status !== 'EXPIRED') {
        await tx.giftCard.update({ where: { id: card.id }, data: { status: 'EXPIRED' } });
      }
      throw new GiftCardError('EXPIRED', 'This gift card has expired.');
    }
    if (card.balance_cents <= 0 || card.status === 'REDEEMED') {
      throw new GiftCardError('INSUFFICIENT_BALANCE', 'This gift card has no remaining balance.');
    }

    // Lock the Order row FOR UPDATE before reading its ledger. Without it, a
    // concurrent collectBalance (booking.ts) reads the same balance_due and both
    // writers zero it last-writer-wins, double-paying the customer. The lock
    // serialises the two writers: the loser blocks until the winner commits, then
    // reads the freshly-reduced balance_due and applies against what's truly left.
    // Held to end-of-tx. We lock only the Order row, scoping contention to this order.
    const lockedOrder = await tx.$queryRaw<
      Array<{ id: string; status: string; total_cents: number; amount_paid_cents: number; balance_due_cents: number }>
    >`
      SELECT id, status, total_cents, amount_paid_cents, balance_due_cents
      FROM "Order"
      WHERE id = ${input.orderId}
      FOR UPDATE`;
    const order = lockedOrder[0];
    if (!order) throw new GiftCardError('ORDER_NOT_FOUND', 'Order not found.', 404);
    // Same payable-state bar as collectBalance: a cancelled order must never take
    // money. Without this, a public redeem drains a card into a dead booking — and
    // a gift-card Payment has no processor transaction, so refunding it back out
    // is impossible through the app.
    if (order.status === 'CANCELLED') {
      throw new GiftCardError('ORDER_CANCELLED', 'This order has been cancelled.', 409);
    }

    const requested = input.amountCents ?? order.balance_due_cents;
    const applied = Math.min(card.balance_cents, requested, order.balance_due_cents);
    if (applied <= 0) {
      throw new GiftCardError('NOTHING_TO_APPLY', 'This order has no outstanding balance to cover.');
    }

    // Atomically claim the funds FIRST: the decrement only lands while the card
    // still holds at least `applied`, so two concurrent redeems can't both spend
    // the same balance. The loser matches 0 rows and is rejected before any Payment
    // is written, so the card can never be over-drawn.
    const claim = await tx.giftCard.updateMany({
      where: { id: card.id, status: { not: 'REDEEMED' }, balance_cents: { gte: applied } },
      data: { balance_cents: { decrement: applied } },
    });
    if (claim.count === 0) {
      throw new GiftCardError('INSUFFICIENT_BALANCE', 'This gift card balance changed — please try again.');
    }
    const afterClaim = await tx.giftCard.findUniqueOrThrow({ where: { id: card.id } });
    if (afterClaim.balance_cents <= 0 && afterClaim.status !== 'REDEEMED') {
      await tx.giftCard.update({ where: { id: card.id }, data: { status: 'REDEEMED' } });
    }

    const payment = await tx.payment.create({
      data: {
        operator_id: operatorId,
        order_id: order.id,
        method: 'GIFT_CARD',
        status: 'PAID',
        amount_cents: applied,
        gift_card_id: card.id,
        // Real idempotency key so a retry hits the @@unique([operator_id,
        // idempotency_key]) index instead of writing a duplicate GIFT_CARD
        // Payment (a NULL key is treated as distinct by Postgres, so it guards
        // nothing). Keyed on the pre-apply amount_paid so distinct top-ups differ.
        idempotency_key: `giftcard-${card.id}-${order.id}-${order.amount_paid_cents}`,
      },
    });

    const newAmountPaid = order.amount_paid_cents + applied;
    const newBalanceDue = Math.max(0, order.total_cents - newAmountPaid);
    await tx.order.update({
      where: { id: order.id },
      data: { amount_paid_cents: newAmountPaid, balance_due_cents: newBalanceDue },
    });

    await tx.orderEvent.create({
      data: {
        operator_id: operatorId,
        order_id: order.id,
        type: 'PAYMENT',
        description: `Redeemed gift card ${card.code} (${formatUSD(applied)})`,
        actor: input.actor ?? 'customer',
        metadata: {
          paymentId: payment.id,
          giftCardId: card.id,
          appliedCents: applied,
          cardBalanceCents: afterClaim.balance_cents,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      giftCardId: card.id,
      code: card.code,
      appliedCents: applied,
      cardBalanceCents: afterClaim.balance_cents,
      cardStatus: afterClaim.balance_cents <= 0 ? 'REDEEMED' : 'ACTIVE',
      orderAmountPaidCents: newAmountPaid,
      orderBalanceDueCents: newBalanceDue,
    };
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Outstanding gift-card liability (money owed to holders) for the operator. */
export async function giftCardLiabilityCents(operatorId: string): Promise<number> {
  const db = forOperator(operatorId);
  const agg = await db.giftCard.aggregate({
    where: { status: 'ACTIVE' },
    _sum: { balance_cents: true },
  });
  return agg._sum.balance_cents ?? 0;
}
