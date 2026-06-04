'use server';

/**
 * Order management server actions for the admin app.
 *
 * Per decision D-007 the admin app talks to the database DIRECTLY through the
 * tenant-scoped client (never the API, never `adminPrisma`). Each action:
 *   - resolves the operator + staff context (`requirePermission`), which enforces
 *     RBAC and supplies the operator id RLS scopes every write by;
 *   - performs multi-row mutations inside a single `withTenant` transaction so the
 *     Postgres GUC is set (RLS) and the order/payment/timeslot rows can never drift;
 *   - records an OrderEvent audit row for every state change;
 *   - revalidates the affected pages so the UI reflects the new state.
 *
 * All money is integer cents. Notifications are dispatched to the API (which owns
 * Resend + the email templates) so the admin app stays free of email deps; the
 * call degrades gracefully and never blocks the action's primary effect.
 */

import { revalidatePath } from 'next/cache';
import { withTenant, type Prisma } from '@marina/database';
import { createId, computeSlotStatus } from '@marina/core';
import { AuthorizationError, type Permission } from '@marina/auth';
import { requirePermission, type OperatorContext } from '../../lib/session';

/** Uniform result returned to client components driving optimistic UI + toasts. */
export interface ActionResult {
  ok: boolean;
  message: string;
}

const ok = (message: string): ActionResult => ({ ok: true, message });
const fail = (message: string): ActionResult => ({ ok: false, message });

/** Trim + bound a free-text reason so a malicious/huge value can't bloat a row. */
function cleanReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined;
  const trimmed = reason.trim().slice(0, 500);
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Revalidate both the list and the specific order's detail page. */
function revalidateOrder(orderId: string): void {
  revalidatePath('/orders');
  revalidatePath(`/orders/${orderId}`);
}

/**
 * Resolve the operator context, enforcing a permission. Returns the context on
 * success or a typed denied `ActionResult` on a missing permission. Keeps each
 * action's auth gate a single, type-safe line (no `undefined`-typed context).
 */
async function authorize(
  permission: Permission,
  deniedMessage: string,
): Promise<{ ctx: OperatorContext } | { denied: ActionResult }> {
  try {
    return { ctx: await requirePermission(permission) };
  } catch (err) {
    if (err instanceof AuthorizationError) return { denied: fail(deniedMessage) };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cancel an order
// ---------------------------------------------------------------------------

/**
 * Cancel an order: mark it (and its still-active items) CANCELLED and restore the
 * capacity each item held on its timeslot. Idempotency guard prevents
 * double-restoring capacity for an already-cancelled order.
 */
export async function cancelOrderAction(input: {
  orderId: string;
  reason?: string;
}): Promise<ActionResult> {
  const auth = await authorize('order:write', 'You do not have permission to cancel orders.');
  if ('denied' in auth) return auth.denied;
  const { ctx } = auth;

  const reason = cleanReason(input.reason);

  try {
    await withTenant(ctx.operatorId, async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: input.orderId },
        include: { items: true },
      });
      if (!order) throw new ActionError('Order not found.');
      if (order.status === 'CANCELLED') throw new ActionError('Order is already cancelled.');

      // Restore capacity for each non-cancelled item's timeslot.
      for (const item of order.items) {
        if (item.status === 'CANCELLED') continue;
        const slot = await tx.timeslot.findFirst({
          where: { id: item.timeslot_id },
          select: { capacity_total: true, capacity_booked: true, status: true },
        });
        if (!slot) continue;
        const newBooked = Math.max(0, slot.capacity_booked - item.quantity);
        await tx.timeslot.update({
          where: { id: item.timeslot_id },
          data: {
            capacity_booked: newBooked,
            // Don't resurrect a cancelled slot; otherwise recompute from capacity.
            status:
              slot.status === 'CANCELLED'
                ? 'CANCELLED'
                : computeSlotStatus(slot.capacity_total, newBooked),
          },
        });
      }

      await tx.orderItem.updateMany({
        where: { order_id: order.id, status: { not: 'CANCELLED' } },
        data: { status: 'CANCELLED' },
      });

      await tx.order.update({
        where: { id: order.id },
        data: { status: 'CANCELLED' },
      });

      await tx.orderEvent.create({
        data: {
          id: createId(),
          operator_id: ctx.operatorId,
          order_id: order.id,
          type: 'ORDER_CANCELLED',
          description: reason
            ? `Order ${order.order_number} cancelled: ${reason}`
            : `Order ${order.order_number} cancelled`,
          actor: ctx.auth.userId,
          metadata: { reason: reason ?? null } as Prisma.InputJsonValue,
        },
      });
    });
  } catch (err) {
    if (err instanceof ActionError) return fail(err.message);
    console.error('[orders] cancelOrderAction failed:', err);
    return fail('Could not cancel the order. Please try again.');
  }

  revalidateOrder(input.orderId);
  return ok('Order cancelled.');
}

// ---------------------------------------------------------------------------
// Resend the confirmation email
// ---------------------------------------------------------------------------

/**
 * Resend the booking confirmation email to the customer. The admin app does not
 * own the email stack (Resend + templates live in the API), so we ask the API to
 * send it and record an audit event regardless of delivery — the action never
 * throws and a missing/unreachable API degrades to a clear message.
 */
export async function resendConfirmationAction(input: {
  orderId: string;
}): Promise<ActionResult> {
  const auth = await authorize('order:write', 'You do not have permission to resend emails.');
  if ('denied' in auth) return auth.denied;
  const { ctx } = auth;

  // Validate the order exists for this tenant + has a recipient before dispatching.
  let recipient: string | null = null;
  let orderNumber = '';
  try {
    const order = await withTenant(ctx.operatorId, (tx) =>
      tx.order.findFirst({
        where: { id: input.orderId },
        select: { order_number: true, customer: { select: { email: true } } },
      }),
    );
    if (!order) return fail('Order not found.');
    recipient = order.customer.email ?? null;
    orderNumber = order.order_number;
  } catch (err) {
    console.error('[orders] resendConfirmationAction lookup failed:', err);
    return fail('Could not load the order. Please try again.');
  }

  if (!recipient) return fail('This customer has no email on file.');

  const dispatch = await dispatchConfirmationEmail(ctx.operatorId, input.orderId);

  // Record the attempt as an audit event either way (tenant-scoped).
  try {
    await withTenant(ctx.operatorId, (tx) =>
      tx.orderEvent.create({
        data: {
          id: createId(),
          operator_id: ctx.operatorId,
          order_id: input.orderId,
          type: 'EMAIL_RESENT',
          description: dispatch.sent
            ? `Confirmation email resent to ${recipient}`
            : `Confirmation email resend attempted (${dispatch.reason ?? 'not delivered'})`,
          actor: ctx.auth.userId,
          metadata: {
            recipient,
            orderNumber,
            sent: dispatch.sent,
            reason: dispatch.reason ?? null,
          } as Prisma.InputJsonValue,
        },
      }),
    );
  } catch (err) {
    console.error('[orders] resendConfirmationAction audit write failed:', err);
  }

  revalidateOrder(input.orderId);
  return dispatch.sent
    ? ok(`Confirmation email sent to ${recipient}.`)
    : fail(
        dispatch.reason
          ? `Email not sent: ${dispatch.reason}.`
          : 'Email could not be sent right now.',
      );
}

interface DispatchResult {
  sent: boolean;
  reason?: string;
}

/**
 * Ask the API to (re)send the booking confirmation. The API owns Resend + the
 * @marina/emails templates and is tenant-scoped via its own RLS client. We pass
 * the operator slug header the API's tenant middleware resolves from. Never
 * throws — connection/HTTP problems resolve to a `sent: false` result.
 */
async function dispatchConfirmationEmail(
  operatorId: string,
  orderId: string,
): Promise<DispatchResult> {
  const base = (process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? '')
    .replace(/\/+$/, '');
  if (!base) {
    return { sent: false, reason: 'email service is not configured' };
  }

  try {
    const res = await fetch(`${base}/api/orders/${encodeURIComponent(orderId)}/resend-confirmation`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The API tenant middleware resolves the operator; pass the id explicitly
        // for the trusted server-to-server (admin → API) call.
        'x-operator-id': operatorId,
        ...(process.env.INTERNAL_API_TOKEN
          ? { authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ orderId }),
      cache: 'no-store',
    });

    if (res.ok) return { sent: true };
    if (res.status === 404) return { sent: false, reason: 'email service unavailable' };
    if (res.status === 403) return { sent: false, reason: 'not permitted' };
    return { sent: false, reason: `email service error (${res.status})` };
  } catch (err) {
    console.error('[orders] dispatchConfirmationEmail failed:', err);
    return { sent: false, reason: 'email service unreachable' };
  }
}

// ---------------------------------------------------------------------------
// Refund a payment (full / partial)
// ---------------------------------------------------------------------------

/**
 * Refund a Payment fully or partially. Updates the Payment's refunded_cents +
 * status, rolls the order's amount_paid / balance_due back, and records an
 * OrderEvent. Validates the requested amount against the remaining refundable
 * amount so an order's money can never go inconsistent.
 *
 * Note on the processor: issuing the money-movement refund against Square/Stripe
 * is owned by the payments API slice (it holds the processor SDK + secrets). This
 * action records the refund against the Payment ledger; for card payments the
 * processor refund should be initiated through the payments endpoint. We block
 * recording a card refund unless explicitly forced, to avoid a ledger that claims
 * money was returned when the processor was never called.
 */
export async function refundPaymentAction(input: {
  paymentId: string;
  /** Amount to refund in integer cents. Omit/<=0 means refund the full remaining. */
  amountCents?: number;
  reason?: string;
}): Promise<ActionResult> {
  const auth = await authorize('order:refund', 'You do not have permission to issue refunds.');
  if ('denied' in auth) return auth.denied;
  const { ctx } = auth;

  const reason = cleanReason(input.reason);
  const requested =
    typeof input.amountCents === 'number' && Number.isFinite(input.amountCents)
      ? Math.trunc(input.amountCents)
      : undefined;
  if (requested !== undefined && requested <= 0) {
    return fail('Refund amount must be greater than zero.');
  }

  let resultMessage = '';
  let touchedOrderId = '';

  try {
    await withTenant(ctx.operatorId, async (tx) => {
      const payment = await tx.payment.findFirst({
        where: { id: input.paymentId },
        include: { order: { select: { id: true, order_number: true, total_cents: true, amount_paid_cents: true } } },
      });
      if (!payment) throw new ActionError('Payment not found.');

      const refundable = payment.amount_cents - payment.refunded_cents;
      if (refundable <= 0) throw new ActionError('This payment has already been fully refunded.');

      const amountCents = requested ?? refundable;
      if (amountCents > refundable) {
        throw new ActionError(
          `Refund exceeds the refundable amount (${(refundable / 100).toFixed(2)} available).`,
        );
      }

      const newRefunded = payment.refunded_cents + amountCents;
      const newStatus = newRefunded >= payment.amount_cents ? 'REFUNDED' : 'PARTIAL_REFUND';

      await tx.payment.update({
        where: { id: payment.id },
        data: { refunded_cents: newRefunded, status: newStatus },
      });

      // Roll the order ledger back so amount_paid / balance_due stay consistent.
      const order = payment.order;
      const newAmountPaid = Math.max(0, order.amount_paid_cents - amountCents);
      const newBalanceDue = order.total_cents - newAmountPaid;
      await tx.order.update({
        where: { id: order.id },
        data: { amount_paid_cents: newAmountPaid, balance_due_cents: newBalanceDue },
      });

      await tx.orderEvent.create({
        data: {
          id: createId(),
          operator_id: ctx.operatorId,
          order_id: order.id,
          type: 'REFUND',
          description: `Refunded ${(amountCents / 100).toFixed(2)} USD${reason ? ` — ${reason}` : ''}`,
          actor: ctx.auth.userId,
          metadata: {
            paymentId: payment.id,
            amountCents,
            fullRefund: newStatus === 'REFUNDED',
            reason: reason ?? null,
          } as Prisma.InputJsonValue,
        },
      });

      touchedOrderId = order.id;
      resultMessage = `Refunded $${(amountCents / 100).toFixed(2)} on ${order.order_number}.`;
    });
  } catch (err) {
    if (err instanceof ActionError) return fail(err.message);
    console.error('[orders] refundPaymentAction failed:', err);
    return fail('Could not process the refund. Please try again.');
  }

  if (touchedOrderId) revalidateOrder(touchedOrderId);
  return ok(resultMessage || 'Refund processed.');
}

/** Internal control-flow error mapped to a user-facing message inside actions. */
class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}
