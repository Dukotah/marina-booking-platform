/**
 * Payments API — charge a booking, finish a 3-D Secure challenge, and refund.
 *
 *   POST /api/payments/charge        public  — charge a card against an order
 *   POST /api/payments/confirm       public  — complete/abandon a 3DS challenge
 *   POST /api/payments/:id/refund    staff   — full/partial refund (order:refund)
 *
 * All money is integer cents. Every DB write is tenant-scoped (RLS via c.var.db)
 * and the multi-row mutations run inside a single tenant transaction so an order's
 * balance and its payment row can never drift. Stripe's network call happens
 * BEFORE the transaction (you don't want to hold a DB tx open across an external
 * HTTP call); the transaction then records the already-settled result.
 *
 * 3-D SECURE / SCA. A card that needs the bank's second factor is NOT a decline —
 * treating it as one (which this route used to do, via a bare 402) is the Phase-1
 * blocker docs/LOCAL-FIRST-BUILD.md §5 names, and it is a dead end for real cards,
 * EU guests and high-value bookings. `POST /charge` now answers 200 with
 * `requiresAction: true` plus whatever the guest's browser needs to continue, and
 * `POST /confirm` finishes the job. A challenged booking is INDISTINGUISHABLE from
 * an unchallenged one once complete: same totals, same Payment ledger row, same
 * OrderEvent — both paths run `recordSettledCharge` below, which is why they cannot
 * drift apart.
 *
 * If Stripe isn't configured, every endpoint returns a clean 501 instead of
 * crashing — payments are an opt-in integration.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import { withTenant } from '@marina/database';
import type { TenantClient } from '@marina/database';
import { createId } from '@marina/core';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import { getClientIp } from '../middleware/rate-limit.js';
import {
  AUDIT_ACTIONS,
  customerActor,
  recordAudit,
  staffActor,
  type AuditActor,
} from '../services/audit.js';
import {
  createPayment,
  refundPayment,
  arePaymentsEnabled,
  getStripeClient,
  StripeNotConfiguredError,
  StripePaymentError,
  type StripePaymentResult,
} from '../services/stripe.js';
import {
  confirmChallenge as sandboxConfirmChallenge,
  sandboxPaymentsEnabled,
  type SandboxChallengeRequired,
} from '../services/payments-sandbox.js';
import { cancelBooking, BookingError } from '../services/booking.js';
import {
  evaluateApproval,
  loadApprovalPolicy,
  recordApprovalEvent,
} from '../services/approvals.js';

export const payments = new Hono<Env>();

const chargeSchema = z.object({
  orderId: z.string().min(1),
  /** Stripe PaymentMethod id created client-side by Stripe.js / Elements. */
  sourceId: z.string().min(1),
  /** Amount to charge, integer cents. Defaults to the order's full balance. */
  amountCents: z.number().int().positive().optional(),
  /** Client-supplied key to make retries safe; generated if absent. */
  idempotencyKey: z.string().min(1).max(45).optional(),
});

const confirmSchema = z.object({
  orderId: z.string().min(1),
  /**
   * The PaymentIntent the challenge belongs to. Optional because the checkout's
   * server action narrows the charge response before the browser sees it; when it
   * is absent we look the outstanding challenge up from the order instead of
   * failing, so the guest is never stranded by a plumbing detail.
   */
  intentId: z.string().min(1).optional(),
  /**
   * `complete` — the guest finished at their bank. `cancel` — they backed out, and
   * the order created for this attempt must not be left holding capacity.
   */
  action: z.enum(['complete', 'cancel']).default('complete'),
});

const refundSchema = z.object({
  /** Amount to refund, integer cents. Defaults to the full remaining refundable. */
  amountCents: z.number().int().positive().optional(),
  reason: z.string().max(192).optional(),
});

/** Map a Stripe service error to a clean JSON response. */
function stripeErrorResponse(c: Context<Env>, err: unknown) {
  if (err instanceof StripeNotConfiguredError) {
    return c.json({ error: 'payments not configured' }, 501);
  }
  if (err instanceof StripePaymentError) {
    return c.json(
      { error: err.message, code: err.code ?? null },
      err.status as ContentfulStatusCode,
    );
  }
  throw err; // unexpected — let the central error handler 500 it
}

// ===========================================================================
// 3-D Secure / SCA
// ===========================================================================

/** Everything the browser needs to get the guest through their bank's challenge. */
interface ChallengeAffordance {
  /** Which driver raised it — the client authenticates differently for each. */
  provider: 'sandbox' | 'stripe';
  intentId: string | null;
  /** Stripe.js needs this to run the challenge; the simulator does not. */
  clientSecret: string | null;
  returnUrl: string | null;
}

/**
 * Recognise a challenge hiding inside a payment error.
 *
 * The local simulator throws `SandboxChallengeRequired`, which carries the intent,
 * the client secret and a return URL. The Stripe driver currently throws a plain
 * `StripePaymentError` whose `code` is the intent status, so the code is the only
 * thing both drivers are guaranteed to share and the rest is read defensively.
 *
 * KNOWN GAP: `services/stripe.ts` discards the PaymentIntent when it refuses a
 * non-succeeded status, so in cloud mode `intentId`/`clientSecret` come back null
 * and the browser has nothing to hand Stripe.js. Closing it is a change to that
 * file (throw a challenge error carrying `intent.id` + `intent.client_secret`);
 * this route already reads those fields, so nothing here changes when it lands.
 */
function challengeFrom(err: unknown): ChallengeAffordance | null {
  if (!(err instanceof StripePaymentError) || err.code !== 'requires_action') return null;
  const carrier = err as StripePaymentError & Partial<SandboxChallengeRequired>;
  return {
    provider: sandboxPaymentsEnabled() ? 'sandbox' : 'stripe',
    intentId: carrier.intentId ?? null,
    clientSecret: carrier.clientSecret ?? null,
    returnUrl: carrier.challengeUrl ?? null,
  };
}

/**
 * The intent of the challenge still outstanding against this order, if any.
 *
 * Sandbox-only: the simulator keeps its own attempt ledger, which is exactly the
 * lookup Stripe would answer from its side. In cloud mode there is nothing local
 * to read, so the client must send the intent id it was given.
 */
async function pendingIntentForOrder(db: TenantClient, orderId: string): Promise<string | null> {
  if (!sandboxPaymentsEnabled()) return null;
  const attempt = await db.sandboxPaymentAttempt.findFirst({
    where: { order_id: orderId, status: 'REQUIRES_ACTION' },
    orderBy: { created_at: 'desc' },
    select: { intent_id: true },
  });
  return attempt?.intent_id ?? null;
}

/**
 * Settle a challenge the guest just completed.
 *
 * In cloud mode the browser has already run the bank's challenge through
 * Stripe.js, so the intent is settled on Stripe's side by the time we get here —
 * we re-read it rather than trusting the client's word that it worked, because
 * "the customer said the payment succeeded" is not a payment.
 */
async function completeChallenge(
  operatorId: string,
  intentId: string,
): Promise<StripePaymentResult> {
  if (sandboxPaymentsEnabled()) {
    return sandboxConfirmChallenge({ operatorId, intentId, succeed: true });
  }

  const stripe = getStripeClient();
  const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
  if (intent.status !== 'succeeded') {
    throw new StripePaymentError(
      intent.status === 'requires_action'
        ? 'Your bank has not confirmed this payment yet. Please complete the check and try again.'
        : 'We could not authenticate this payment. Please try a different card.',
      402,
      intent.status,
    );
  }

  const charge =
    intent.latest_charge && typeof intent.latest_charge !== 'string' ? intent.latest_charge : null;
  const card = charge?.payment_method_details?.card ?? null;
  return {
    paymentId: intent.id,
    status: intent.status,
    amountCents:
      typeof intent.amount_received === 'number' ? intent.amount_received : intent.amount,
    cardBrand: card?.brand ?? null,
    cardLastFour: card?.last4 ?? null,
    cardholderName: charge?.billing_details?.name ?? null,
    receiptUrl: charge?.receipt_url ?? null,
  };
}

/**
 * Abandon a challenge the guest backed out of.
 *
 * The simulator signals a failed authentication by THROWING after it has recorded
 * the attempt as FAILED — that is its contract, so the one expected error is
 * swallowed and anything else (a missing intent, an illegal transition) still
 * surfaces. A cloud cancel is best-effort: Stripe expires an unconfirmed intent on
 * its own, and failing to cancel it must not stop us releasing the guest's seats.
 */
async function abandonChallenge(operatorId: string, intentId: string): Promise<void> {
  if (sandboxPaymentsEnabled()) {
    try {
      await sandboxConfirmChallenge({ operatorId, intentId, succeed: false });
    } catch (err) {
      const expected =
        err instanceof StripePaymentError &&
        err.code === 'payment_intent_authentication_failure';
      if (!expected) throw err;
    }
    return;
  }

  try {
    await getStripeClient().paymentIntents.cancel(intentId);
  } catch (err) {
    console.warn(`[payments] could not cancel intent ${intentId}:`, err);
  }
}

// ===========================================================================
// Shared settlement — the single place a successful charge is written down
// ===========================================================================

/** The order fields settlement needs; kept structural so both routes can pass theirs. */
interface SettleableOrder {
  id: string;
  order_number: string;
  customer_id: string;
  total_cents: number;
  amount_paid_cents: number;
  balance_due_cents: number;
}

interface SettledCharge {
  payment: {
    id: string;
    status: string;
    amountCents: number;
    cardBrand: string | null;
    cardLastFour: string | null;
    processorTransactionId: string | null;
  };
  amountPaidCents: number;
  balanceDueCents: number;
}

/**
 * Record an already-settled charge against the order, atomically.
 *
 * Both the straight-success path and the 3DS-completed path call this and nothing
 * else, which is what makes a challenged booking indistinguishable from an
 * unchallenged one: identical Payment row, identical balance arithmetic, identical
 * audit event. Anything that differed between the two would be a bug the ledger
 * eventually has to answer for. The `payment.capture` audit row is written here for
 * that same reason — recording it in each route would let the two drift.
 */
async function recordSettledCharge(
  operatorId: string,
  order: SettleableOrder,
  amountCents: number,
  result: StripePaymentResult,
  audit: { actor: AuditActor; authenticated3ds: boolean },
): Promise<SettledCharge> {
  const amountPaidCents = order.amount_paid_cents + amountCents;
  const balanceDueCents = order.total_cents - amountPaidCents;

  const payment = await withTenant(operatorId, async (tx) => {
    const created = await tx.payment.create({
      data: {
        id: createId(),
        operator_id: operatorId,
        order_id: order.id,
        method: 'CARD',
        status: 'PAID',
        amount_cents: amountCents,
        card_brand: result.cardBrand,
        card_last_four: result.cardLastFour,
        cardholder_name: result.cardholderName,
        processor: 'STRIPE',
        processor_transaction_id: result.paymentId,
      },
    });

    await tx.order.update({
      where: { id: order.id },
      data: { amount_paid_cents: amountPaidCents, balance_due_cents: balanceDueCents },
    });

    await tx.orderEvent.create({
      data: {
        id: createId(),
        operator_id: operatorId,
        order_id: order.id,
        type: 'PAYMENT',
        description: `Charged card ending ${result.cardLastFour ?? '????'}`,
        actor: 'customer',
        metadata: {
          paymentId: created.id,
          processorTransactionId: result.paymentId,
          amountCents,
          receiptUrl: result.receiptUrl,
        },
      },
    });

    return created;
  });

  // After the transaction, never inside it: a failed audit insert would abort the
  // whole tx and take the guest's settled payment with it (services/audit.ts).
  await recordAudit({
    operatorId,
    actor: audit.actor,
    action: AUDIT_ACTIONS.PAYMENT_CAPTURE,
    entityType: 'Payment',
    entityId: payment.id,
    before: {
      amount_paid_cents: order.amount_paid_cents,
      balance_due_cents: order.balance_due_cents,
    },
    after: { amount_paid_cents: amountPaidCents, balance_due_cents: balanceDueCents },
    context: {
      order_id: order.id,
      order_number: order.order_number,
      captured_cents: amountCents,
      order_total_cents: order.total_cents,
      method: 'CARD',
      processor: 'STRIPE',
      processor_transaction_id: result.paymentId,
      card_brand: result.cardBrand,
      card_last_four: result.cardLastFour,
      authenticated_3ds: audit.authenticated3ds,
    },
  });

  return {
    payment: {
      id: payment.id,
      status: payment.status,
      amountCents: payment.amount_cents,
      cardBrand: payment.card_brand,
      cardLastFour: payment.card_last_four,
      processorTransactionId: payment.processor_transaction_id,
    },
    amountPaidCents,
    balanceDueCents,
  };
}

/**
 * POST /api/payments/charge — public. Charges a card via Square, records a
 * Payment row, advances the order's amount_paid / balance_due, and logs an
 * OrderEvent. Public because customers pay during checkout (no staff session).
 */
payments.post('/charge', async (c) => {
  if (!arePaymentsEnabled()) {
    return c.json({ error: 'payments not configured' }, 501);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = chargeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  const { orderId, sourceId } = parsed.data;

  // Load the order (RLS-scoped) to determine how much to charge and to validate.
  const order = await c.var.db.order.findUnique({ where: { id: orderId } });
  if (!order) {
    return c.json({ error: 'Order not found' }, 404);
  }

  const amountCents = parsed.data.amountCents ?? order.balance_due_cents;
  if (amountCents <= 0) {
    return c.json({ error: 'Nothing to charge — order has no outstanding balance' }, 400);
  }
  if (amountCents > order.balance_due_cents) {
    return c.json(
      { error: 'Charge exceeds the outstanding balance', balanceDueCents: order.balance_due_cents },
      400,
    );
  }

  // Charge Square OUTSIDE the DB transaction (external network call).
  let result;
  try {
    result = await createPayment({
      orderId: order.id,
      sourceId,
      amountCents,
      idempotencyKey: parsed.data.idempotencyKey ?? createId(),
      // Saves the local simulator a cross-tenant order lookup.
      operatorId: c.var.operatorId,
    });
  } catch (err) {
    // A 3DS/SCA challenge is not a failure — it is the bank asking the guest a
    // question. Answer 200 with everything the browser needs to ask it, and leave
    // the order's money untouched until POST /confirm says the guest answered.
    const challenge = challengeFrom(err);
    if (challenge) {
      return c.json({
        requiresAction: true,
        payment: {
          // No Payment row exists yet, so the intent IS the client's handle on
          // this attempt — it is what /confirm expects back.
          id: challenge.intentId ?? '',
          status: 'REQUIRES_ACTION',
          amountCents,
          cardBrand: null,
          cardLastFour: null,
          processorTransactionId: challenge.intentId,
          receiptUrl: null,
        },
        order: {
          id: order.id,
          amountPaidCents: order.amount_paid_cents,
          balanceDueCents: order.balance_due_cents,
        },
        authentication: challenge,
      });
    }

    // A terminal decline must not leave a booking behind. createBooking reserves the
    // seat when the order is created, so without this a declined card leaves an
    // UPCOMING order on the operator's manifest, holding capacity, for a guest who
    // never paid — the exact half-created state the build contract forbids.
    //
    // Only for a first, wholly unpaid charge: if anything has already been collected
    // this is a staff balance-collection or a deposit top-up, and cancelling the
    // whole booking because a second card failed would be far worse than leaving it.
    if (order.amount_paid_cents === 0 && order.status === 'UPCOMING') {
      const priorPayments = await c.var.db.payment.count({
        where: { order_id: order.id, status: { in: ['PAID', 'PARTIAL_REFUND', 'REFUNDED'] } },
      });
      if (priorPayments === 0) {
        try {
          // Cancel first: that is the tested path that returns the seat to the
          // timeslot (and to any shared resource pool), so capacity is correct even
          // if the delete below fails.
          await cancelBooking(c.var.operatorId, order.id, {
            actor: 'system',
            reason: 'Payment declined at checkout — booking released',
          });
          // Then remove it. An abandoned checkout never became a booking, and an
          // operator who leaves a busy Saturday with thirty dead CANCELLED rows in
          // Orders cannot see the real ones. The attempt is NOT lost: the payment
          // ledger keeps it with its decline reason, which is where a failed charge
          // belongs. Cascades clear the items, events and any payment rows.
          await c.var.db.order.delete({ where: { id: order.id } });
        } catch (releaseErr) {
          // Never let the cleanup mask the payment error the guest needs to see.
          console.error('[payments] failed to release declined order', order.id, releaseErr);
        }
      }
    }

    return stripeErrorResponse(c, err);
  }

  const settled = await recordSettledCharge(c.var.operatorId, order, amountCents, result, {
    // Checkout is unauthenticated by design, so the strongest attribution we can
    // honestly make is the order's own customer; the IP is what corroborates it.
    actor: customerActor(order.customer_id, getClientIp((h) => c.req.header(h))),
    authenticated3ds: false,
  });

  return c.json(
    {
      payment: { ...settled.payment, receiptUrl: result.receiptUrl },
      order: {
        id: order.id,
        amountPaidCents: settled.amountPaidCents,
        balanceDueCents: settled.balanceDueCents,
      },
    },
    201,
  );
});

/**
 * POST /api/payments/confirm — public. Finishes the 3-D Secure round trip the
 * charge above started.
 *
 *   action=complete — the guest authenticated at their bank. The intent is settled
 *     with whichever driver owns it and then recorded exactly as a straight success
 *     would be, so the booking is confirmed and the ledger balances.
 *   action=cancel — the guest backed out. The intent is abandoned AND the order
 *     created for this attempt is cancelled, releasing its capacity. Leaving it
 *     behind is the "half-created order" LOCAL-FIRST-BUILD §5 forbids: seats held
 *     for a booking nobody paid for and nobody will show up to.
 *
 * Public for the same reason /charge is: the guest is mid-checkout with no session.
 */
payments.post('/confirm', async (c) => {
  if (!arePaymentsEnabled()) {
    return c.json({ error: 'payments not configured' }, 501);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  const { orderId, action } = parsed.data;

  const order = await c.var.db.order.findUnique({ where: { id: orderId } });
  if (!order) {
    return c.json({ error: 'Order not found' }, 404);
  }

  const intentId = parsed.data.intentId ?? (await pendingIntentForOrder(c.var.db, order.id));
  if (!intentId) {
    return c.json(
      {
        error: 'There is no payment awaiting authentication for this booking.',
        code: 'no_pending_authentication',
      },
      409,
    );
  }

  if (action === 'cancel') {
    try {
      await abandonChallenge(c.var.operatorId, intentId);
    } catch (err) {
      return stripeErrorResponse(c, err);
    }

    try {
      await cancelBooking(c.var.operatorId, order.id, {
        actor: 'customer',
        reason: 'Card authentication was cancelled before payment',
      });
    } catch (err) {
      // Already cancelled is the desired end state, not a failure to report.
      if (!(err instanceof BookingError) || err.code !== 'ALREADY_CANCELLED') throw err;
    }

    return c.json({
      cancelled: true,
      order: { id: order.id, orderNumber: order.order_number, status: 'CANCELLED' },
    });
  }

  // A guest who double-taps "Authenticate" must not be charged twice. The intent
  // is the durable key: if it is already on a Payment row, that attempt is done and
  // this call replays its answer rather than settling a second time.
  const existing = await c.var.db.payment.findFirst({
    where: { processor_transaction_id: intentId, order_id: order.id },
  });
  if (existing) {
    return c.json({
      payment: {
        id: existing.id,
        status: existing.status,
        amountCents: existing.amount_cents,
        cardBrand: existing.card_brand,
        cardLastFour: existing.card_last_four,
        processorTransactionId: existing.processor_transaction_id,
        receiptUrl: null,
      },
      order: {
        id: order.id,
        orderNumber: order.order_number,
        amountPaidCents: order.amount_paid_cents,
        balanceDueCents: order.balance_due_cents,
      },
    });
  }

  let result: StripePaymentResult;
  try {
    result = await completeChallenge(c.var.operatorId, intentId);
  } catch (err) {
    return stripeErrorResponse(c, err);
  }

  // The processor is the authority on how much actually moved (a partial capture
  // settles for less than it authorized), but it can never be allowed to push the
  // order past paid-in-full — that would invent money the guest does not owe.
  const amountCents = Math.min(result.amountCents, order.balance_due_cents);
  if (amountCents <= 0) {
    return c.json(
      { error: 'Nothing to settle — order has no outstanding balance', code: 'nothing_to_settle' },
      409,
    );
  }

  const settled = await recordSettledCharge(c.var.operatorId, order, amountCents, result, {
    actor: customerActor(order.customer_id, getClientIp((h) => c.req.header(h))),
    authenticated3ds: true,
  });

  return c.json(
    {
      payment: { ...settled.payment, receiptUrl: result.receiptUrl },
      order: {
        id: order.id,
        orderNumber: order.order_number,
        amountPaidCents: settled.amountPaidCents,
        balanceDueCents: settled.balanceDueCents,
      },
    },
    201,
  );
});

/**
 * POST /api/payments/:id/refund — staff (order:refund). Refunds a Payment fully
 * or partially via Square, updates the Payment's refunded_cents + status, rolls
 * the order's amount_paid / balance_due back, and logs an OrderEvent.
 */
payments.post('/:id/refund', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:refund');

  if (!arePaymentsEnabled()) {
    return c.json({ error: 'payments not configured' }, 501);
  }

  const paymentId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = refundSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }

  const payment = await c.var.db.payment.findUnique({ where: { id: paymentId } });
  if (!payment) {
    return c.json({ error: 'Payment not found' }, 404);
  }
  if (payment.processor !== 'STRIPE' || !payment.processor_transaction_id) {
    return c.json({ error: 'Payment is not a refundable Stripe transaction' }, 400);
  }

  const refundable = payment.amount_cents - payment.refunded_cents;
  if (refundable <= 0) {
    return c.json({ error: 'Payment has already been fully refunded' }, 400);
  }

  const amountCents = parsed.data.amountCents ?? refundable;
  if (amountCents > refundable) {
    return c.json(
      { error: 'Refund exceeds the refundable amount', refundableCents: refundable },
      400,
    );
  }

  // Manager-approval gate (Singenuity §2): if the operator requires sign-off for
  // refunds (always, or above a threshold) and this caller lacks order:approve,
  // block with a clear 403 so a manager can complete it. A caller WITH order:approve
  // self-approves and we leave an APPROVAL audit event on the order below.
  const policy = await loadApprovalPolicy(c.var.db, c.var.operatorId);
  const approval = evaluateApproval({
    action: 'refund',
    amountCents,
    policy,
    auth: c.var.auth,
  });
  if (approval.blocked) {
    return c.json(
      {
        error: approval.reason ?? 'This refund requires manager approval',
        code: 'APPROVAL_REQUIRED',
        requiresPermission: 'order:approve',
      },
      403,
    );
  }

  // Issue the refund with Square OUTSIDE the DB transaction.
  let result;
  try {
    result = await refundPayment({
      paymentId: payment.processor_transaction_id,
      amountCents,
      reason: parsed.data.reason,
      operatorId: c.var.operatorId,
    });
  } catch (err) {
    return stripeErrorResponse(c, err);
  }

  const newRefunded = payment.refunded_cents + amountCents;
  const newStatus = newRefunded >= payment.amount_cents ? 'REFUNDED' : 'PARTIAL_REFUND';

  // Roll the order balance back. Load inside the tx for a consistent read.
  const updated = await withTenant(c.var.operatorId, async (tx) => {
    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: { refunded_cents: newRefunded, status: newStatus },
    });

    const order = await tx.order.findUnique({ where: { id: payment.order_id } });
    // The balance the refund moved FROM, captured in the same transaction that
    // moves it — a refund's audit row is worthless without what the balance was
    // and what it became.
    const orderBefore = order
      ? {
          amountPaidCents: order.amount_paid_cents,
          balanceDueCents: order.balance_due_cents,
          orderNumber: order.order_number,
        }
      : null;

    let orderSummary: { amountPaidCents: number; balanceDueCents: number } | null = null;
    if (order) {
      const newAmountPaid = Math.max(0, order.amount_paid_cents - amountCents);
      const newBalanceDue = order.total_cents - newAmountPaid;
      await tx.order.update({
        where: { id: order.id },
        data: { amount_paid_cents: newAmountPaid, balance_due_cents: newBalanceDue },
      });
      orderSummary = { amountPaidCents: newAmountPaid, balanceDueCents: newBalanceDue };
    }

    // If this refund crossed the approval gate, record who signed off (self-approval
    // by a manager) alongside the refund, in the same transaction.
    if (approval.required) {
      await recordApprovalEvent(tx, {
        operatorId: c.var.operatorId,
        orderId: payment.order_id,
        action: 'refund',
        amountCents,
        actor: c.var.auth.userId,
        reason: approval.reason,
      });
    }

    await tx.orderEvent.create({
      data: {
        id: createId(),
        operator_id: c.var.operatorId,
        order_id: payment.order_id,
        type: 'REFUND',
        description: `Refunded ${(amountCents / 100).toFixed(2)} USD${
          parsed.data.reason ? ` — ${parsed.data.reason}` : ''
        }`,
        actor: c.var.auth.userId,
        metadata: {
          paymentId: payment.id,
          processorRefundId: result.refundId,
          amountCents,
          reason: parsed.data.reason ?? null,
        },
      },
    });

    return { updatedPayment, orderSummary, orderBefore };
  });

  await recordAudit({
    operatorId: c.var.operatorId,
    actor: staffActor(c.var.auth, getClientIp((h) => c.req.header(h))),
    action: AUDIT_ACTIONS.PAYMENT_REFUND,
    entityType: 'Payment',
    entityId: payment.id,
    before: {
      status: payment.status,
      refunded_cents: payment.refunded_cents,
      order_amount_paid_cents: updated.orderBefore?.amountPaidCents ?? null,
      order_balance_due_cents: updated.orderBefore?.balanceDueCents ?? null,
    },
    after: {
      status: updated.updatedPayment.status,
      refunded_cents: updated.updatedPayment.refunded_cents,
      order_amount_paid_cents: updated.orderSummary?.amountPaidCents ?? null,
      order_balance_due_cents: updated.orderSummary?.balanceDueCents ?? null,
    },
    context: {
      refunded_now_cents: amountCents,
      // A partial refund and a final one are different events to a reconciler,
      // and the amounts alone do not say which this was.
      partial: newStatus === 'PARTIAL_REFUND',
      payment_amount_cents: payment.amount_cents,
      order_id: payment.order_id,
      order_number: updated.orderBefore?.orderNumber ?? null,
      reason: parsed.data.reason ?? null,
      processor: payment.processor,
      processor_refund_id: result.refundId,
      processor_refund_status: result.status,
      approval_required: approval.required,
      ...(approval.required ? { self_approved_by: c.var.auth.userId } : {}),
    },
  });

  return c.json({
    refund: {
      id: result.refundId,
      status: result.status,
      amountCents,
    },
    payment: {
      id: updated.updatedPayment.id,
      status: updated.updatedPayment.status,
      amountCents: updated.updatedPayment.amount_cents,
      refundedCents: updated.updatedPayment.refunded_cents,
    },
    order: updated.orderSummary,
  });
});
