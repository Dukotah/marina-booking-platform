/**
 * Gift card service — issue, redeem, and look up stored-value gift cards. Gift
 * cards are a money instrument, so this module follows the same rigor as the
 * booking service:
 *
 *   - every mutation runs inside a tenant-scoped transaction (`withTenant`) so RLS
 *     scopes the writes and the balance change + ledger entry are atomic;
 *   - the balance is decremented with a *conditional* update guarded on the current
 *     balance, so two concurrent redemptions can never overspend a card (the DB,
 *     not a read-then-write race, is the arbiter);
 *   - every change appends a GiftCardTransaction row, so the signed ledger sums to
 *     the card's current balance (audit trail).
 *
 * Amounts are always integer cents. The card `code` is the bearer secret — anyone
 * holding it can check the balance and (staff-side) redeem against it.
 */
import { Prisma } from '@marina/database';
import { generateGiftCardCode } from '@marina/core';
import { withTenant } from '@marina/database';

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

export interface IssueGiftCardInput {
  /** Amount to load onto the card, in integer cents. Must be > 0. */
  amountCents: number;
  purchaserName?: string | null;
  purchaserEmail?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  message?: string | null;
  /** ISO date/datetime; the card cannot be redeemed after this instant. */
  expiresAt?: string | Date | null;
}

export interface IssueGiftCardOptions {
  /** Audit actor (staff id/email, or 'customer'). Also stored as `issued_by`. */
  actor?: string;
}

/**
 * Normalize a redemption code to its canonical stored form (uppercase, trimmed).
 * Dashes/spacing are preserved as entered after upper-casing so a customer can type
 * it with or without the grouping we display.
 */
function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Issue (create + load) a new gift card for the operator. Generates a unique code,
 * records the card and an ISSUE ledger entry in one transaction, and retries on the
 * rare code collision.
 */
export async function issueGiftCard(
  operatorId: string,
  input: IssueGiftCardInput,
  options: IssueGiftCardOptions = {},
) {
  const amount = Math.trunc(input.amountCents);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new GiftCardError('INVALID_AMOUNT', 'Gift card amount must be a positive number of cents');
  }

  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new GiftCardError('INVALID_EXPIRY', 'expiresAt is not a valid date');
  }
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new GiftCardError('INVALID_EXPIRY', 'expiresAt must be in the future');
  }

  // Retry a handful of times against the (operator, code) uniqueness constraint.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateGiftCardCode();
    try {
      return await withTenant(operatorId, async (tx) => {
        const card = await tx.giftCard.create({
          data: {
            operator_id: operatorId,
            code,
            initial_cents: amount,
            balance_cents: amount,
            is_active: true,
            purchaser_name: input.purchaserName ?? null,
            purchaser_email: input.purchaserEmail ?? null,
            recipient_name: input.recipientName ?? null,
            recipient_email: input.recipientEmail ?? null,
            message: input.message ?? null,
            issued_by: options.actor ?? null,
            expires_at: expiresAt,
            transactions: {
              // operator_id is derived from the parent card via the tenant-composite
              // relation (D-011) — do not pass it on the nested create.
              create: [
                {
                  type: 'ISSUE',
                  amount_cents: amount,
                  balance_after_cents: amount,
                  actor: options.actor ?? null,
                  note: 'Gift card issued',
                },
              ],
            },
          },
        });
        return card;
      });
    } catch (err) {
      // Unique-constraint collision on the code → regenerate and retry.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        attempt < MAX_ATTEMPTS - 1
      ) {
        continue;
      }
      throw err;
    }
  }
  // Exhausted retries — astronomically unlikely.
  throw new GiftCardError('CODE_GENERATION_FAILED', 'Could not allocate a unique gift card code', 500);
}

/**
 * Look up a gift card by its code (tenant-scoped). Returns null if no card matches.
 * Use for a public balance check — the code is the bearer secret.
 */
export async function getGiftCardByCode(operatorId: string, rawCode: string) {
  const code = normalizeCode(rawCode);
  return withTenant(operatorId, async (tx) =>
    tx.giftCard.findFirst({ where: { code } }),
  );
}

export interface RedeemGiftCardOptions {
  /** Order the redemption is applied to, recorded on the ledger entry. */
  orderId?: string;
  actor?: string;
  note?: string;
}

/**
 * Redeem `amountCents` from a gift card identified by its code. Atomic and
 * overspend-safe: the balance is decremented with a conditional update guarded on
 * the card being active and holding at least `amountCents`; if the guard matches no
 * row the redemption is refused. Records a REDEEM ledger entry and returns the
 * updated card plus the amount actually applied.
 */
export async function redeemGiftCard(
  operatorId: string,
  rawCode: string,
  amountCents: number,
  options: RedeemGiftCardOptions = {},
) {
  const code = normalizeCode(rawCode);
  const amount = Math.trunc(amountCents);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new GiftCardError('INVALID_AMOUNT', 'Redemption amount must be a positive number of cents');
  }

  return withTenant(operatorId, async (tx) => {
    const card = await tx.giftCard.findFirst({ where: { code } });
    if (!card) {
      throw new GiftCardError('GIFT_CARD_NOT_FOUND', 'No gift card matches that code', 404);
    }
    if (!card.is_active) {
      throw new GiftCardError('GIFT_CARD_INACTIVE', 'This gift card is not active', 409);
    }
    if (card.expires_at && card.expires_at.getTime() <= Date.now()) {
      throw new GiftCardError('GIFT_CARD_EXPIRED', 'This gift card has expired', 409);
    }
    if (card.balance_cents < amount) {
      throw new GiftCardError(
        'INSUFFICIENT_BALANCE',
        `Gift card balance is ${card.balance_cents} cent(s); cannot redeem ${amount}`,
        409,
      );
    }

    // Conditional decrement — the WHERE re-checks active + sufficient balance, so a
    // concurrent redemption that already drew the card down makes this match 0 rows.
    const guarded = await tx.giftCard.updateMany({
      where: { id: card.id, is_active: true, balance_cents: { gte: amount } },
      data: { balance_cents: { decrement: amount } },
    });
    if (guarded.count !== 1) {
      // Lost the race (or it was voided between read and write).
      throw new GiftCardError(
        'INSUFFICIENT_BALANCE',
        'Gift card balance changed; please retry',
        409,
      );
    }

    const newBalance = card.balance_cents - amount;
    await tx.giftCardTransaction.create({
      data: {
        operator_id: operatorId,
        gift_card_id: card.id,
        type: 'REDEEM',
        amount_cents: -amount, // signed: redemption draws the balance down
        balance_after_cents: newBalance,
        order_id: options.orderId ?? null,
        actor: options.actor ?? null,
        note: options.note ?? null,
      },
    });

    const updated = await tx.giftCard.findFirst({ where: { id: card.id } });
    return { card: updated!, amountAppliedCents: amount, balanceCents: newBalance };
  });
}

export interface ApplyGiftCardOptions {
  /** Amount to apply, integer cents. Defaults to min(card balance, order balance due). */
  amountCents?: number;
  actor?: string;
}

/**
 * Apply a gift card as **tender** against an order's outstanding balance — the
 * money path that lets a gift card pay for a booking (staff/POS today; customer
 * checkout is a follow-up). Everything happens in ONE tenant transaction so the
 * card draw-down, the Payment row, and the order's amount_paid/balance_due can
 * never drift:
 *   - validates the order is open and has a balance due;
 *   - resolves + validates the card (active, unexpired) and draws it down with the
 *     same overspend-safe conditional decrement as `redeemGiftCard`;
 *   - records a signed REDEEM ledger entry (stamped with the order id), a
 *     `Payment{ method: GIFT_CARD }`, advances the order, and logs an OrderEvent.
 *
 * The applied amount is the smaller of (requested | card balance | balance due);
 * a request that exceeds the balance due or the card balance is refused.
 */
export async function applyGiftCardToOrder(
  operatorId: string,
  orderId: string,
  rawCode: string,
  options: ApplyGiftCardOptions = {},
) {
  const code = normalizeCode(rawCode);

  return withTenant(operatorId, async (tx) => {
    const order = await tx.order.findFirst({ where: { id: orderId } });
    if (!order) {
      throw new GiftCardError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    if (order.status === 'CANCELLED') {
      throw new GiftCardError('ORDER_CANCELLED', 'This order has been cancelled', 409);
    }
    const balanceDue = order.balance_due_cents;
    if (balanceDue <= 0) {
      throw new GiftCardError('NOTHING_DUE', 'This order has no outstanding balance', 400);
    }

    const card = await tx.giftCard.findFirst({ where: { code } });
    if (!card) {
      throw new GiftCardError('GIFT_CARD_NOT_FOUND', 'No gift card matches that code', 404);
    }
    if (!card.is_active) {
      throw new GiftCardError('GIFT_CARD_INACTIVE', 'This gift card is not active', 409);
    }
    if (card.expires_at && card.expires_at.getTime() <= Date.now()) {
      throw new GiftCardError('GIFT_CARD_EXPIRED', 'This gift card has expired', 409);
    }

    // Amount to apply: requested, else as much as covers the balance from the card.
    const requested =
      options.amountCents != null
        ? Math.trunc(options.amountCents)
        : Math.min(card.balance_cents, balanceDue);
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new GiftCardError('INVALID_AMOUNT', 'Amount to apply must be a positive number of cents');
    }
    if (requested > balanceDue) {
      throw new GiftCardError(
        'EXCEEDS_BALANCE_DUE',
        `Amount exceeds the order's outstanding balance (${balanceDue} cent(s))`,
      );
    }
    if (requested > card.balance_cents) {
      throw new GiftCardError(
        'INSUFFICIENT_BALANCE',
        `Gift card balance is ${card.balance_cents} cent(s); cannot apply ${requested}`,
        409,
      );
    }

    // Overspend-safe conditional decrement (DB arbitrates a concurrent draw-down).
    const guarded = await tx.giftCard.updateMany({
      where: { id: card.id, is_active: true, balance_cents: { gte: requested } },
      data: { balance_cents: { decrement: requested } },
    });
    if (guarded.count !== 1) {
      throw new GiftCardError('INSUFFICIENT_BALANCE', 'Gift card balance changed; please retry', 409);
    }
    const newCardBalance = card.balance_cents - requested;

    const gcTxn = await tx.giftCardTransaction.create({
      data: {
        operator_id: operatorId,
        gift_card_id: card.id,
        type: 'REDEEM',
        amount_cents: -requested,
        balance_after_cents: newCardBalance,
        order_id: order.id,
        actor: options.actor ?? null,
        note: `Applied to order ${order.order_number}`,
      },
    });

    const newAmountPaid = order.amount_paid_cents + requested;
    const newBalanceDue = order.total_cents - newAmountPaid;
    const payment = await tx.payment.create({
      data: {
        operator_id: operatorId,
        order_id: order.id,
        method: 'GIFT_CARD',
        status: 'PAID',
        amount_cents: requested,
        // No card processor for stored value; link the Payment to its ledger entry.
        processor_transaction_id: gcTxn.id,
      },
    });
    await tx.order.update({
      where: { id: order.id },
      data: { amount_paid_cents: newAmountPaid, balance_due_cents: newBalanceDue },
    });
    await tx.orderEvent.create({
      data: {
        operator_id: operatorId,
        order_id: order.id,
        type: 'PAYMENT',
        description: `Applied gift card ${card.code} — ${(requested / 100).toFixed(2)} USD`,
        actor: options.actor ?? null,
        metadata: {
          paymentId: payment.id,
          giftCardId: card.id,
          giftCardTransactionId: gcTxn.id,
          amountCents: requested,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      payment: { id: payment.id, method: 'GIFT_CARD' as const, amountCents: requested },
      order: { id: order.id, amountPaidCents: newAmountPaid, balanceDueCents: newBalanceDue },
      giftCard: { code: card.code, balanceCents: newCardBalance },
    };
  });
}
