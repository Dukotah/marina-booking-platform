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
