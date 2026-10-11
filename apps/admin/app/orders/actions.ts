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
import {
  createId,
  computeSlotStatus,
  computeCancellationRefund,
  type CancellationPolicy,
} from '@marina/core';
import { AuthorizationError, type Permission } from '@marina/auth';
import { requirePermission, getTenantDb, type OperatorContext } from '../../lib/session';

/** Uniform result returned to client components driving optimistic UI + toasts. */
export interface ActionResult {
  ok: boolean;
  message: string;
}

const ok = (message: string): ActionResult => ({ ok: true, message });
const fail = (message: string): ActionResult => ({ ok: false, message });

/**
 * Headers for a trusted admin -> API call (the payment/processor paths the admin does
 * NOT own, per D-007).
 *
 * Two things the API needs and the raw call was missing:
 *   - `x-operator-id`: the operator PK, which the API's tenant middleware now resolves
 *     for server-to-server calls.
 *   - staff identity: `POST /collect-balance` is behind `requireStaff`. When Clerk is not
 *     enforced (local dev, tests — REQUIRE_CLERK_AUTH unset/false) the API trusts the
 *     `x-dev-staff-id` shim, so we forward the resolved staff id the same way the e2e
 *     suite does; without it the call was rejected 401 the moment it reached the API.
 *     Under enforced Clerk this is omitted (a real bearer token path would be wired
 *     instead), so it can never weaken a production deployment.
 */
function internalApiHeaders(ctx: OperatorContext): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-operator-id': ctx.operatorId,
  };
  if (process.env.REQUIRE_CLERK_AUTH !== 'true') {
    headers['x-dev-staff-id'] = ctx.auth.userId;
  }
  if (process.env.INTERNAL_API_TOKEN) {
    headers.authorization = `Bearer ${process.env.INTERNAL_API_TOKEN}`;
  }
  return headers;
}

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
// Refund preview (read-only) — what a cancel would refund, before committing
// ---------------------------------------------------------------------------

/**
 * A built-in full-refund policy, used ONLY when neither the Activity nor the
 * Operator has one configured. Mirrors `SAFE_DEFAULT_CANCELLATION_POLICY` in the
 * API's booking service so the preview matches exactly what `cancelBooking` would
 * do: a missing policy must never silently keep a guest's money.
 */
const SAFE_DEFAULT_CANCELLATION_POLICY: CancellationPolicy = {
  tiers: [{ min_hours_before: 0, refund_percent: 100 }],
  cancellation_fee_cents: 0,
  fee_scope: 'order',
  self_cancel_hours: 0,
  refund_method: 'card',
};

/**
 * Coerce an untyped `cancellation_policy` JSON blob into a `CancellationPolicy`, or
 * null when absent / malformed. Same guard the API uses so a bad row degrades to
 * "no policy at this level" rather than throwing in the preview.
 */
function coercePolicy(raw: unknown): CancellationPolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<CancellationPolicy>;
  if (!Array.isArray(p.tiers)) return null;
  return {
    tiers: p.tiers,
    cancellation_fee_cents: Math.max(0, Number(p.cancellation_fee_cents ?? 0) | 0),
    fee_scope: p.fee_scope === 'guest' ? 'guest' : 'order',
    self_cancel_hours: Math.max(0, Number(p.self_cancel_hours ?? 0)),
    refund_method:
      p.refund_method === 'gift_card' || p.refund_method === 'card_then_gift'
        ? p.refund_method
        : 'card',
  };
}

/** What the reservation card shows before staff confirm a cancel. */
export interface RefundPreview {
  ok: boolean;
  message?: string;
  /** Cents that would be refunded after the tier % and any fee. */
  refundCents?: number;
  /** Tier percent applied (0-100). */
  tierPercent?: number;
  /** Flat fee withheld (cents). */
  feeCents?: number;
  /** Amount the guest has paid so far (cents) — the refund can never exceed it. */
  amountPaidCents?: number;
}

/**
 * Compute (read-only) the refund a cancel WOULD issue, so staff see "$X will be
 * refunded (50% tier, minus $Y fee)" before committing. This reuses the exact same
 * inputs the API's `cancelBooking` uses:
 *   - effective policy = Activity.cancellation_policy ?? Operator.cancellation_policy
 *     ?? a safe full-refund default,
 *   - the booking's EARLIEST still-active item start vs. now,
 *   - total guest count (for a per-guest fee),
 *   - amount_paid_cents,
 * fed through the shared `computeCancellationRefund` core helper. Nothing is
 * written; staff can preview freely regardless of the approval gate.
 */
export async function previewCancellationRefund(input: {
  orderId: string;
}): Promise<RefundPreview> {
  const auth = await authorize('order:write', 'You do not have permission to view this.');
  if ('denied' in auth) return { ok: false, message: auth.denied.message };

  if (!input.orderId) return { ok: false, message: 'Missing order.' };

  try {
    const db = await getTenantDb();

    const order = await db.order.findFirst({
      where: { id: input.orderId },
      select: {
        amount_paid_cents: true,
        status: true,
        items: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            quantity: true,
            activity: { select: { cancellation_policy: true } },
            timeslot: { select: { datetime: true } },
          },
        },
      },
    });
    if (!order) return { ok: false, message: 'Order not found.' };
    if (order.status === 'CANCELLED') return { ok: false, message: 'Order is already cancelled.' };
    if (order.items.length === 0) return { ok: false, message: 'Nothing left to cancel.' };

    const operator = await db.operator.findFirst({ select: { cancellation_policy: true } });

    // Activity override wins (first active item carrying one), else operator default,
    // else the safe full-refund fallback — the same precedence as cancelBooking.
    const activityPolicyRaw =
      order.items.find((i) => i.activity?.cancellation_policy)?.activity?.cancellation_policy ??
      null;
    const policy: CancellationPolicy =
      coercePolicy(activityPolicyRaw) ??
      coercePolicy(operator?.cancellation_policy ?? null) ??
      SAFE_DEFAULT_CANCELLATION_POLICY;

    // Earliest still-active start; the whole order is evaluated against it.
    const earliestStart = order.items.reduce<Date | null>((min, i) => {
      const d = i.timeslot?.datetime ?? null;
      if (!d) return min;
      return min === null || d < min ? d : min;
    }, null);

    const guestCount = order.items.reduce((n, i) => n + i.quantity, 0) || 1;

    const now = new Date();
    const computed = computeCancellationRefund({
      policy,
      startsAt: earliestStart ?? now,
      now,
      amountPaidCents: order.amount_paid_cents,
      guestCount,
    });

    return {
      ok: true,
      refundCents: computed.refundCents,
      tierPercent: computed.tierPercent,
      feeCents: computed.feeCents,
      amountPaidCents: order.amount_paid_cents,
    };
  } catch (err) {
    console.error('[orders] previewCancellationRefund failed:', err);
    return { ok: false, message: 'Could not compute the refund preview.' };
  }
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
 * Note on the processor: issuing the money-movement refund against Stripe
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
      // Serialize concurrent refunds of the same payment: lock the row first so the
      // refundable-amount check reads a value no other refund can change under us.
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${input.paymentId} FOR UPDATE`;

      const payment = await tx.payment.findFirst({
        where: { id: input.paymentId },
        include: { order: { select: { id: true, order_number: true, total_cents: true, amount_paid_cents: true } } },
      });
      if (!payment) throw new ActionError('Payment not found.');

      // A card refund moves real money and must go through the payments API (which
      // owns the Stripe SDK) — recording it here without calling Stripe would claim
      // money was returned when it wasn't. Only enforce when a real processor is
      // configured; in dev/demo (fake payments) there is nothing to call, so a
      // ledger-only refund is correct and must not be blocked.
      const realPaymentsConfigured =
        !!process.env.STRIPE_SECRET_KEY && process.env.DEV_FAKE_PAYMENTS !== 'true';
      if (
        realPaymentsConfigured &&
        payment.method === 'CARD' &&
        payment.processor === 'STRIPE' &&
        !payment.is_manually_keyed
      ) {
        throw new ActionError(
          'Card refunds must be issued through the payments endpoint (which calls Stripe) first, then recorded here.',
        );
      }

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

// ---------------------------------------------------------------------------
// Collect the remaining balance on a deposit order
// ---------------------------------------------------------------------------

/**
 * Collect the outstanding balance on a deposit order ("pay the rest at check-in").
 * The (simulated) card charge is owned by the payments/processor logic in the API,
 * so this action asks the API to charge the balance, record the Payment + zero the
 * balance_due, and log a BALANCE_COLLECTED OrderEvent — then revalidates the page.
 * Never throws; an unreachable/misconfigured API degrades to a clear message.
 */
export async function collectBalanceAction(input: {
  orderId: string;
  method?: 'CARD' | 'CASH';
}): Promise<ActionResult> {
  const auth = await authorize('order:write', 'You do not have permission to collect payments.');
  if ('denied' in auth) return auth.denied;
  const { ctx } = auth;

  const base = (process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(
    /\/+$/,
    '',
  );
  if (!base) return fail('The payments service is not configured.');

  try {
    const res = await fetch(
      `${base}/api/orders/${encodeURIComponent(input.orderId)}/collect-balance`,
      {
        method: 'POST',
        headers: internalApiHeaders(ctx),
        body: JSON.stringify({ method: input.method ?? 'CARD' }),
        cache: 'no-store',
      },
    );

    if (res.ok) {
      const data = (await res.json().catch(() => null)) as
        | { result?: { chargedCents?: number; orderNumber?: string } }
        | null;
      const charged = data?.result?.chargedCents;
      revalidateOrder(input.orderId);
      return ok(
        typeof charged === 'number'
          ? `Collected $${(charged / 100).toFixed(2)}. Order paid in full.`
          : 'Balance collected. Order paid in full.',
      );
    }

    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (res.status === 400 && body?.error) return fail(body.error);
    if (res.status === 404) return fail('Order not found.');
    if (res.status === 409 && body?.error) return fail(body.error);
    if (res.status === 501) return fail('Payments are not configured.');
    return fail(body?.error ?? `Could not collect the balance (${res.status}).`);
  } catch (err) {
    console.error('[orders] collectBalanceAction failed:', err);
    return fail('Could not reach the payments service. Please try again.');
  }
}

/** The post-trip charge kinds the manifest offers. Free string in the DB (like
 *  OrderEvent.type), validated to this set at the boundary. */
const CHARGE_CATEGORIES = ['FUEL', 'CLEANING', 'DAMAGE', 'LATE', 'OTHER'] as const;

function defaultChargeLabel(category: string): string {
  switch (category) {
    case 'FUEL':
      return 'Fuel';
    case 'CLEANING':
      return 'Cleaning';
    case 'DAMAGE':
      return 'Damage';
    case 'LATE':
      return 'Late return';
    default:
      return 'Charge';
  }
}

/**
 * Add an ad-hoc charge (fuel, cleaning, damage, late fee) to an existing order — the
 * post-trip "charge the boat for the fuel it used" flow run from the manifest when a
 * boat returns. Records an OrderCharge line and adds the amount to the order's total
 * + balance_due; the staff then settle that new balance with cash or card via
 * collectBalanceAction. Direct DB write per D-007 (no processor involved here).
 */
export async function addOrderChargeAction(input: {
  orderId: string;
  category: string;
  label?: string;
  amountCents: number;
  /**
   * Optional reusable charge preset. When supplied it pre-fills the charge's
   * category/label/amount, but any explicit field the caller sends still wins — the
   * staff can tweak a preset before posting it. A preset from another tenant is
   * invisible under RLS (findFirst returns null), so a bad id is simply ignored.
   */
  presetId?: string;
}): Promise<ActionResult> {
  const auth = await authorize('order:write', 'You do not have permission to add charges.');
  if ('denied' in auth) return auth.denied;
  const { ctx } = auth;

  // Resolve a preset first (tenant-scoped) so its values seed anything the caller
  // left blank. Explicit caller input always overrides the preset.
  let preset: { category: string; label: string; amount_cents: number } | null = null;
  if (input.presetId) {
    try {
      preset = await withTenant(ctx.operatorId, (tx) =>
        tx.chargePreset.findFirst({
          where: { id: input.presetId, active: true },
          select: { category: true, label: true, amount_cents: true },
        }),
      );
    } catch (err) {
      console.error('[orders] addOrderChargeAction preset lookup failed:', err);
    }
  }

  const rawAmount =
    typeof input.amountCents === 'number' && Number.isFinite(input.amountCents) && input.amountCents > 0
      ? input.amountCents
      : preset?.amount_cents ?? input.amountCents;
  const amountCents = Math.trunc(rawAmount);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return fail('Enter a charge amount greater than zero.');
  }
  if (amountCents > 1_000_000) {
    return fail('That charge looks too large — enter dollars, not cents.');
  }
  const requestedCategory = input.category || preset?.category || 'OTHER';
  const category = (CHARGE_CATEGORIES as readonly string[]).includes(requestedCategory)
    ? requestedCategory
    : 'OTHER';
  const label =
    cleanReason(input.label) ?? cleanReason(preset?.label) ?? defaultChargeLabel(category);

  try {
    await withTenant(ctx.operatorId, async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: input.orderId },
        select: { id: true, order_number: true, total_cents: true, balance_due_cents: true },
      });
      if (!order) throw new ActionError('Order not found.');

      await tx.orderCharge.create({
        data: {
          id: createId(),
          operator_id: ctx.operatorId,
          order_id: order.id,
          category,
          label,
          amount_cents: amountCents,
          created_by: ctx.auth.userId,
        },
      });

      await tx.order.update({
        where: { id: order.id },
        data: {
          total_cents: order.total_cents + amountCents,
          balance_due_cents: order.balance_due_cents + amountCents,
        },
      });

      await tx.orderEvent.create({
        data: {
          id: createId(),
          operator_id: ctx.operatorId,
          order_id: order.id,
          type: 'CHARGE_ADDED',
          description: `Added ${label} charge of $${(amountCents / 100).toFixed(2)}`,
          actor: ctx.auth.userId,
          metadata: { category, label, amountCents } as Prisma.InputJsonValue,
        },
      });
    });
  } catch (err) {
    if (err instanceof ActionError) return fail(err.message);
    console.error('[orders] addOrderChargeAction failed:', err);
    return fail('Could not add the charge. Please try again.');
  }

  revalidateOrder(input.orderId);
  revalidatePath('/manifest');
  return ok(`Added ${label} — $${(amountCents / 100).toFixed(2)}. Collect it below.`);
}

/** Internal control-flow error mapped to a user-facing message inside actions. */
class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}
