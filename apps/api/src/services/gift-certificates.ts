/**
 * Gift certificate service — issue, look up, and redeem SINGLE-USE certificates.
 *
 * A GiftCertificate is DISTINCT from the stored-value GiftCard: it carries a fixed
 * value (optionally tied to a specific activity/experience) and is consumed in ONE
 * redemption — there is no running balance. Redeeming applies min(value, order
 * balance due) as a Payment (method GIFT_CARD) against the order and flips the
 * certificate to REDEEMED so it can never be reused. All mutation runs inside a
 * single tenant-scoped transaction (`withTenant`) so RLS scopes every row and two
 * concurrent redemptions can't spend the same certificate twice.
 */

import { randomInt } from 'node:crypto';
import { Prisma, forOperator, withTenant, type GiftCertificate } from '@marina/database';
import { formatUSD } from '@marina/core';

/** A typed, user-facing failure route handlers map to a clean HTTP status. */
export class GiftCertificateError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'GiftCertificateError';
    this.code = code;
    this.status = status;
  }
}

// Unambiguous alphabet — no 0/O/1/I/L to avoid read/transcription errors.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomSegment(length = 4): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Certificates use a distinct GC- prefix so codes don't collide with gift cards. */
function generateCode(): string {
  return `GC-${randomSegment()}-${randomSegment()}`;
}

/** Normalize user-entered codes (case + surrounding whitespace) for lookup. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export interface IssueGiftCertificateInput {
  valueCents: number;
  /** Optional: tie the certificate to a specific activity/experience. */
  activityId?: string;
  purchaserEmail?: string;
  recipientName?: string;
  recipientEmail?: string;
  message?: string;
  expiresAt?: Date;
}

/**
 * Issue a new ACTIVE gift certificate with a unique code and fixed value.
 * When activityId is given it is validated to belong to this operator (RLS).
 * Retries on the (rare) code collision against the per-operator unique index.
 */
export async function issueGiftCertificate(
  operatorId: string,
  input: IssueGiftCertificateInput,
): Promise<GiftCertificate> {
  if (!Number.isInteger(input.valueCents) || input.valueCents <= 0) {
    throw new GiftCertificateError(
      'INVALID_AMOUNT',
      'Gift certificate value must be a positive whole number of cents.',
    );
  }
  const db = forOperator(operatorId);

  if (input.activityId) {
    const activity = await db.activity.findUnique({ where: { id: input.activityId } });
    if (!activity) {
      throw new GiftCertificateError('ACTIVITY_NOT_FOUND', 'Activity not found for this certificate.', 404);
    }
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      return await db.giftCertificate.create({
        data: {
          operator_id: operatorId,
          code,
          value_cents: input.valueCents,
          activity_id: input.activityId ?? null,
          status: 'ACTIVE',
          purchaser_email: input.purchaserEmail ?? null,
          recipient_name: input.recipientName ?? null,
          recipient_email: input.recipientEmail ?? null,
          message: input.message ?? null,
          expires_at: input.expiresAt ?? null,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
  }
  throw new GiftCertificateError('CODE_COLLISION', 'Could not allocate a unique certificate code; please retry.', 500);
}

// ---------------------------------------------------------------------------
// Lookup / validate
// ---------------------------------------------------------------------------

export interface GiftCertificateCheck {
  valid: boolean;
  code: string;
  valueCents: number;
  status: GiftCertificate['status'];
  /** Present when the certificate is tied to a specific activity. */
  activityId: string | null;
  /** Present when valid is false. */
  reason?: string;
}

/** Load a certificate by its (normalized) code within the operator. */
export async function getGiftCertificateByCode(
  operatorId: string,
  code: string,
): Promise<GiftCertificate | null> {
  const db = forOperator(operatorId);
  return db.giftCertificate.findUnique({
    where: { operator_id_code: { operator_id: operatorId, code: normalizeCode(code) } },
  });
}

/** Is this certificate usable right now? Safe to expose publicly. */
export async function checkGiftCertificate(
  operatorId: string,
  code: string,
): Promise<GiftCertificateCheck> {
  const cert = await getGiftCertificateByCode(operatorId, code);
  if (!cert) {
    return {
      valid: false,
      code: normalizeCode(code),
      valueCents: 0,
      status: 'VOID',
      activityId: null,
      reason: 'No gift certificate with that code.',
    };
  }
  const base = {
    code: cert.code,
    valueCents: cert.value_cents,
    status: cert.status,
    activityId: cert.activity_id,
  };
  if (cert.status === 'VOID') return { valid: false, ...base, reason: 'This gift certificate has been voided.' };
  if (cert.status === 'REDEEMED')
    return { valid: false, ...base, reason: 'This gift certificate has already been redeemed.' };
  if (cert.expires_at && cert.expires_at.getTime() < Date.now())
    return { valid: false, ...base, status: 'EXPIRED', reason: 'This gift certificate has expired.' };
  return { valid: true, ...base };
}

// ---------------------------------------------------------------------------
// Redeem (single-use, settle against an order)
// ---------------------------------------------------------------------------

export interface RedeemGiftCertificateInput {
  code: string;
  orderId: string;
  /** Audit actor (e.g. 'customer' or a staff id/email). */
  actor?: string;
}

export interface RedeemGiftCertificateResult {
  giftCertificateId: string;
  code: string;
  /** Cents actually applied to the order (min of value and order balance due). */
  appliedCents: number;
  /** Order totals after applying the certificate. */
  orderAmountPaidCents: number;
  orderBalanceDueCents: number;
}

/**
 * Redeem a single-use certificate against an order. Applies min(value, order
 * balance due) and marks the certificate REDEEMED — it can never be reused, even
 * if the order balance was smaller than the certificate value (a certificate is
 * consumed whole, not partially, by design). Atomic: reloads the certificate inside
 * the transaction so two concurrent redemptions can't both consume it.
 */
export async function redeemGiftCertificate(
  operatorId: string,
  input: RedeemGiftCertificateInput,
): Promise<RedeemGiftCertificateResult> {
  const normalized = normalizeCode(input.code);

  return withTenant(operatorId, async (tx) => {
    const cert = await tx.giftCertificate.findUnique({
      where: { operator_id_code: { operator_id: operatorId, code: normalized } },
    });
    if (!cert) throw new GiftCertificateError('NOT_FOUND', 'No gift certificate with that code.', 404);
    if (cert.status === 'VOID') throw new GiftCertificateError('VOID', 'This gift certificate has been voided.');
    if (cert.status === 'REDEEMED')
      throw new GiftCertificateError('ALREADY_REDEEMED', 'This gift certificate has already been redeemed.');
    if (cert.expires_at && cert.expires_at.getTime() < Date.now()) {
      if (cert.status !== 'EXPIRED') {
        await tx.giftCertificate.update({ where: { id: cert.id }, data: { status: 'EXPIRED' } });
      }
      throw new GiftCertificateError('EXPIRED', 'This gift certificate has expired.');
    }

    const order = await tx.order.findUnique({ where: { id: input.orderId } });
    if (!order) throw new GiftCertificateError('ORDER_NOT_FOUND', 'Order not found.', 404);

    // If tied to a specific activity, that activity must be on the order.
    if (cert.activity_id) {
      const match = await tx.orderItem.findFirst({
        where: { order_id: order.id, activity_id: cert.activity_id },
        select: { id: true },
      });
      if (!match) {
        throw new GiftCertificateError(
          'ACTIVITY_MISMATCH',
          'This gift certificate is only valid for a specific activity, which is not on this order.',
        );
      }
    }

    const applied = Math.min(cert.value_cents, order.balance_due_cents);
    if (applied <= 0) {
      throw new GiftCertificateError('NOTHING_TO_APPLY', 'This order has no outstanding balance to cover.');
    }

    // Atomically claim the certificate (single-use): only the redeem that flips it
    // from ACTIVE wins. A concurrent second redeem matches 0 rows and is rejected
    // here, BEFORE any Payment is written, so a cert can never be double-spent.
    const claim = await tx.giftCertificate.updateMany({
      where: { id: cert.id, status: 'ACTIVE' },
      data: { status: 'REDEEMED', redeemed_order_id: order.id, redeemed_at: new Date() },
    });
    if (claim.count === 0) {
      throw new GiftCertificateError('ALREADY_REDEEMED', 'This gift certificate has already been redeemed.');
    }

    const payment = await tx.payment.create({
      data: {
        operator_id: operatorId,
        order_id: order.id,
        method: 'GIFT_CARD',
        status: 'PAID',
        amount_cents: applied,
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
        description: `Redeemed gift certificate ${cert.code} (${formatUSD(applied)})`,
        actor: input.actor ?? 'customer',
        metadata: {
          paymentId: payment.id,
          giftCertificateId: cert.id,
          appliedCents: applied,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      giftCertificateId: cert.id,
      code: cert.code,
      appliedCents: applied,
      orderAmountPaidCents: newAmountPaid,
      orderBalanceDueCents: newBalanceDue,
    };
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Outstanding certificate liability (money owed) = SUM(value) of ACTIVE certs. */
export async function giftCertificateLiabilityCents(operatorId: string): Promise<number> {
  const db = forOperator(operatorId);
  const agg = await db.giftCertificate.aggregate({
    where: { status: 'ACTIVE' },
    _sum: { value_cents: true },
  });
  return agg._sum.value_cents ?? 0;
}
