/**
 * Payments API — charge a booking, finish a 3-D Secure challenge, and refund.
 *
 *   GET  /api/payments/config        public  — what the browser needs to pay here
 *   POST /api/payments/charge        public  — charge a card against an order
 *   POST /api/payments/confirm       public  — complete/abandon a 3DS challenge
 *   POST /api/payments/:id/refund    staff   — full/partial refund (order:refund)
 *
 * All money is integer cents. Every DB write is tenant-scoped (RLS via c.var.db)
 * and the multi-row mutations run inside a single tenant transaction so an order's
 * balance and its payment row can never drift. The processor's network call happens
 * BEFORE the transaction (you don't want to hold a DB tx open across an external
 * HTTP call); the transaction then records the already-settled result.
 *
 * PROVIDER SEAM: this route knows no processor. Every money movement goes through
 * the PaymentProvider interface (services/payments), resolved per operator —
 * Stripe, the local sandbox simulator, or "none" (clean 501s). Processor SDK types
 * never appear here; swapping processors is a services/payments change only.
 *
 * 3-D SECURE / SCA. A card that needs the bank's second factor is NOT a decline —
 * treating it as one (which this route used to do, via a bare 402) is the Phase-1
 * blocker docs/LOCAL-FIRST-BUILD.md §5 names, and it is a dead end for real cards,
 * EU guests and high-value bookings. `POST /charge` answers 200 with
 * `requiresAction: true` plus whatever the guest's browser needs to continue, and
 * `POST /confirm` finishes the job. A challenged booking is INDISTINGUISHABLE from
 * an unchallenged one once complete: same totals, same Payment ledger row, same
 * OrderEvent — both paths run `recordSettledCharge` below, which is why they cannot
 * drift apart. Both drivers now carry the intent id + client secret through the
 * `requires_action` outcome (the old Stripe driver discarded them — fixed in
 * services/payments/stripe-provider.ts).
 *
 * If no provider is configured, every endpoint returns a clean 501 instead of
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
  getPaymentProvider,
  PaymentProviderError,
  PaymentsNotConfiguredError,
  type ChargeFailure,
  type PaymentProvider,
  type SettledChargeResult,
} from '../services/payments/index.js';
import { cancelBooking, BookingError, isUniqueViolation } from '../services/booking.js';
import {
  evaluateApproval,
  loadApprovalPolicy,
  recordApprovalEvent,
} from '../services/approvals.js';

export const payments = new Hono<Env>();

const chargeSchema = z.object({
  orderId: z.string().min(1),
  /** Tokenized payment source created client-side (e.g. a Stripe PaymentMethod id). */
  sourceId: z.string().min(1),
  /** Amount to charge, integer cents. Defaults to the order's full balance. */
  amountCents: z.number().int().positive().optional(),
  /** Client-supplied key to make retries safe; generated if absent. */
  idempotencyKey: z.string().min(1).max(45).optional(),
});

const confirmSchema = z.object({
  orderId: z.string().min(1),
  /**
   * The payment intent the challenge belongs to. Optional because the checkout's
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

/** Map a payment-provider error to a clean JSON response. */
function paymentErrorResponse(c: Context<Env>, err: unknown) {
  if (err instanceof PaymentsNotConfiguredError) {
    return c.json({ error: 'payments not configured' }, 501);
  }
  if (err instanceof PaymentProviderError) {
    return c.json(
      { error: err.message, code: err.code ?? null },
      err.status as ContentfulStatusCode,
    );
  }
  throw err; // unexpected — let the central error handler 500 it
}

/** A failed charge outcome, serialized exactly as the thrown-error path would be. */
function chargeFailureResponse(c: Context<Env>, failure: ChargeFailure) {
  return c.json(
    { error: failure.message, code: failure.code },
    failure.httpStatus as ContentfulStatusCode,
  );
}

/** The browser-facing name of the driver a challenge belongs to. */
function challengeProviderName(provider: PaymentProvider): 'sandbox' | 'stripe' {
  return provider.providerKey === 'sandbox' ? 'sandbox' : 'stripe';
}

/**
 * How this deployment takes payment: 'card' (collect online) or 'reserve' (hold
 * the spot, pay on arrival). Mirrors the web app's payment-mode resolution so
 * GET /config can hand the whole payment posture to any client in one call.
 * Defaults to 'card' so a typo never silently stops a site from collecting money.
 */
function resolvePaymentMode(): 'card' | 'reserve' {
  const v = process.env.PAYMENT_MODE?.trim().toLowerCase();
  return v === 'reserve' ? 'reserve' : 'card';
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
 * The atomic settle-charge write: Payment row + order ledger + PAYMENT event. Split
 * out so the caller can catch a unique-key (P2002) conflict around the whole write.
 */
async function recordPaymentRow(
  operatorId: string,
  order: SettleableOrder,
  amountCents: number,
  amountPaidCents: number,
  balanceDueCents: number,
  result: SettledChargeResult,
  idempotencyKey?: string | null,
) {
  return withTenant(operatorId, async (tx) => {
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
        processor_transaction_id: result.paymentRef,
        // Persist the idempotency key so the unique (operator_id, idempotency_key)
        // index actually guards against a retried charge being double-recorded.
        idempotency_key: idempotencyKey ?? null,
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
          processorTransactionId: result.paymentRef,
          amountCents,
          receiptUrl: result.receiptUrl,
        },
      },
    });

    return created;
  });
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
  result: SettledChargeResult,
  audit: { actor: AuditActor; authenticated3ds: boolean },
  idempotencyKey?: string | null,
): Promise<SettledCharge> {
  const amountPaidCents = order.amount_paid_cents + amountCents;
  const balanceDueCents = order.total_cents - amountPaidCents;

  let payment: Awaited<ReturnType<typeof recordPaymentRow>>;
  try {
    payment = await recordPaymentRow(
      operatorId,
      order,
      amountCents,
      amountPaidCents,
      balanceDueCents,
      result,
      idempotencyKey,
    );
  } catch (err) {
    // A concurrent or retried charge under the SAME idempotency key already recorded
    // this payment (unique operator_id+idempotency_key). The processor dedups the
    // charge by that same key, so no money moved twice — return the already-recorded
    // payment instead of failing the retry with a 500. This closes the double-submit
    // race the replay pre-check above narrows but can't fully eliminate.
    if (idempotencyKey && isUniqueViolation(err)) {
      const recovered = await withTenant(operatorId, async (tx) => {
        const existing = await tx.payment.findFirst({ where: { idempotency_key: idempotencyKey } });
        if (!existing) return null;
        const freshOrder = await tx.order.findUnique({ where: { id: existing.order_id } });
        return { existing, freshOrder };
      });
      if (recovered?.existing) {
        const { existing, freshOrder } = recovered;
        return {
          payment: {
            id: existing.id,
            status: existing.status,
            amountCents: existing.amount_cents,
            cardBrand: existing.card_brand,
            cardLastFour: existing.card_last_four,
            processorTransactionId: existing.processor_transaction_id,
          },
          amountPaidCents: freshOrder?.amount_paid_cents ?? amountPaidCents,
          balanceDueCents: freshOrder?.balance_due_cents ?? balanceDueCents,
        };
      }
    }
    throw err;
  }

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
      processor_transaction_id: result.paymentRef,
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
 * A terminal decline must not leave a booking behind. createBooking reserves the
 * seat when the order is created, so without this a declined card leaves an
 * UPCOMING order on the operator's manifest, holding capacity, for a guest who
 * never paid — the exact half-created state the build contract forbids.
 *
 * Only for a first, wholly unpaid charge: if anything has already been collected
 * this is a staff balance-collection or a deposit top-up, and cancelling the
 * whole booking because a second card failed would be far worse than leaving it.
 */
async function releaseDeclinedOrder(
  db: TenantClient,
  operatorId: string,
  order: SettleableOrder & { status: string },
): Promise<void> {
  if (order.amount_paid_cents !== 0 || order.status !== 'UPCOMING') return;
  const priorPayments = await db.payment.count({
    where: { order_id: order.id, status: { in: ['PAID', 'PARTIAL_REFUND', 'REFUNDED'] } },
  });
  if (priorPayments !== 0) return;
  try {
    // Cancel first: that is the tested path that returns the seat to the
    // timeslot (and to any shared resource pool), so capacity is correct even
    // if the delete below fails.
    await cancelBooking(operatorId, order.id, {
      actor: 'system',
      reason: 'Payment declined at checkout — booking released',
    });
    // Then remove it. An abandoned checkout never became a booking, and an
    // operator who leaves a busy Saturday with thirty dead CANCELLED rows in
    // Orders cannot see the real ones. The attempt is NOT lost: the payment
    // ledger keeps it with its decline reason, which is where a failed charge
    // belongs. Cascades clear the items, events and any payment rows.
    await db.order.delete({ where: { id: order.id } });
  } catch (releaseErr) {
    // Never let the cleanup mask the payment error the guest needs to see.
    console.error('[payments] failed to release declined order', order.id, releaseErr);
  }
}

/**
 * GET /api/payments/config — public. Everything the browser needs to take payment
 * on this site: which provider is live, its client-side config (publishable key
 * for Stripe Elements, nothing for the sandbox), and the deployment's payment
 * mode. The checkout reads THIS instead of a NEXT_PUBLIC_* env var, so plugging a
 * processor in (env keys or the admin Integrations page) needs no web redeploy.
 * Never contains a secret.
 */
payments.get('/config', async (c) => {
  const provider = await getPaymentProvider(c.var.operatorId);
  return c.json({
    provider: provider.providerKey,
    enabled: provider.providerKey !== 'none',
    paymentMode: resolvePaymentMode(),
    client: provider.clientConfig(),
  });
});

/**
 * POST /api/payments/charge — public. Charges a card via the resolved provider,
 * records a Payment row, advances the order's amount_paid / balance_due, and logs
 * an OrderEvent. Public because customers pay during checkout (no staff session).
 */
payments.post('/charge', async (c) => {
  const provider = await getPaymentProvider(c.var.operatorId);
  if (provider.providerKey === 'none') {
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

  // Idempotent retry: when the client supplies a stable key and we've already
  // recorded a charge under it, return that payment instead of charging the card a
  // second time (double-click / network-retry protection). Defense-in-depth behind
  // the unique (operator_id, idempotency_key) index recordSettledCharge now writes.
  const idempotencyKey = parsed.data.idempotencyKey ?? createId();
  if (parsed.data.idempotencyKey) {
    const existing = await c.var.db.payment.findFirst({
      where: { idempotency_key: parsed.data.idempotencyKey },
    });
    if (existing) {
      const fresh = await c.var.db.order.findUnique({ where: { id: existing.order_id } });
      return c.json(
        {
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
            amountPaidCents: fresh?.amount_paid_cents ?? order.amount_paid_cents,
            balanceDueCents: fresh?.balance_due_cents ?? order.balance_due_cents,
          },
        },
        201,
      );
    }
  }

  // Charge the provider OUTSIDE the DB transaction (external network call).
  let outcome;
  try {
    outcome = await provider.charge({
      orderId: order.id,
      tokenizedSource: sourceId,
      amountCents,
      idempotencyKey,
      // Saves the local simulator a cross-tenant order lookup.
      operatorId: c.var.operatorId,
    });
  } catch (err) {
    // Configuration faults / unexpected failures still release an unpaid booking.
    await releaseDeclinedOrder(c.var.db, c.var.operatorId, order);
    return paymentErrorResponse(c, err);
  }

  // A 3DS/SCA challenge is not a failure — it is the bank asking the guest a
  // question. Answer 200 with everything the browser needs to ask it, and leave
  // the order's money untouched until POST /confirm says the guest answered.
  if (outcome.status === 'requires_action') {
    return c.json({
      requiresAction: true,
      payment: {
        // No Payment row exists yet, so the intent IS the client's handle on
        // this attempt — it is what /confirm expects back.
        id: outcome.challenge.intentId ?? '',
        status: 'REQUIRES_ACTION',
        amountCents,
        cardBrand: null,
        cardLastFour: null,
        processorTransactionId: outcome.challenge.intentId,
        receiptUrl: null,
      },
      order: {
        id: order.id,
        amountPaidCents: order.amount_paid_cents,
        balanceDueCents: order.balance_due_cents,
      },
      authentication: {
        provider: challengeProviderName(provider),
        intentId: outcome.challenge.intentId,
        clientSecret: outcome.challenge.clientSecret,
        returnUrl: outcome.challenge.returnUrl,
      },
    });
  }

  if (outcome.status === 'failed') {
    await releaseDeclinedOrder(c.var.db, c.var.operatorId, order);
    return chargeFailureResponse(c, outcome.failure);
  }

  const settled = await recordSettledCharge(
    c.var.operatorId,
    order,
    amountCents,
    outcome,
    {
      // Checkout is unauthenticated by design, so the strongest attribution we can
      // honestly make is the order's own customer; the IP is what corroborates it.
      actor: customerActor(order.customer_id, getClientIp((h) => c.req.header(h))),
      authenticated3ds: false,
    },
    idempotencyKey,
  );

  return c.json(
    {
      payment: { ...settled.payment, receiptUrl: outcome.receiptUrl },
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
  const provider = await getPaymentProvider(c.var.operatorId);
  if (provider.providerKey === 'none') {
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

  const intentId =
    parsed.data.intentId ??
    (await provider.pendingChallenge({ orderId: order.id, operatorId: c.var.operatorId }));
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
      await provider.confirmChallenge({ intentId, action: 'cancel', operatorId: c.var.operatorId });
    } catch (err) {
      return paymentErrorResponse(c, err);
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

  let result: SettledChargeResult;
  try {
    const settledResult = await provider.confirmChallenge({
      intentId,
      action: 'complete',
      operatorId: c.var.operatorId,
    });
    if (!settledResult) {
      // Providers return a settled charge for every completed challenge; a null
      // here is a provider bug, not a customer problem.
      throw new PaymentProviderError('The payment could not be confirmed.', 502);
    }
    result = settledResult;
  } catch (err) {
    return paymentErrorResponse(c, err);
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
 * or partially via the resolved provider, updates the Payment's refunded_cents +
 * status, rolls the order's amount_paid / balance_due back, and logs an OrderEvent.
 */
payments.post('/:id/refund', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:refund');

  const provider = await getPaymentProvider(c.var.operatorId);
  if (provider.providerKey === 'none') {
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

  // Issue the refund with the provider OUTSIDE the DB transaction.
  let result;
  try {
    result = await provider.refund({
      paymentRef: payment.processor_transaction_id,
      amountCents,
      reason: parsed.data.reason,
      operatorId: c.var.operatorId,
    });
  } catch (err) {
    return paymentErrorResponse(c, err);
  }

  // Roll the order balance back. Guard against a concurrent refund via an atomic
  // compare-and-swap: the increment only lands while enough refundable headroom
  // remains, so two refunds can't both compute from the same stale refunded_cents
  // and over-refund the ledger past what the card actually captured.
  let refundRaceLost = false;
  const updated = await withTenant(c.var.operatorId, async (tx) => {
    const cas = await tx.payment.updateMany({
      where: { id: payment.id, refunded_cents: { lte: payment.amount_cents - amountCents } },
      data: { refunded_cents: { increment: amountCents } },
    });
    if (cas.count === 0) {
      refundRaceLost = true;
      return null;
    }
    const reread = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: reread.refunded_cents >= payment.amount_cents ? 'REFUNDED' : 'PARTIAL_REFUND',
      },
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
          processorRefundId: result.refundRef,
          amountCents,
          reason: parsed.data.reason ?? null,
        },
      },
    });

    return { updatedPayment, orderSummary, orderBefore };
  });

  if (refundRaceLost || !updated) {
    // A concurrent refund consumed the remaining refundable amount between our
    // pre-check and the ledger write. Report a conflict rather than record an
    // over-refund (processors themselves also cap refunds at the captured total).
    return c.json({ error: 'Refund exceeds the refundable amount', code: 'REFUND_CONFLICT' }, 409);
  }

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
      partial: updated.updatedPayment.status === 'PARTIAL_REFUND',
      payment_amount_cents: payment.amount_cents,
      order_id: payment.order_id,
      order_number: updated.orderBefore?.orderNumber ?? null,
      reason: parsed.data.reason ?? null,
      processor: payment.processor,
      processor_refund_id: result.refundRef,
      processor_refund_status: result.status,
      approval_required: approval.required,
      ...(approval.required ? { self_approved_by: c.var.auth.userId } : {}),
    },
  });

  return c.json({
    refund: {
      id: result.refundRef,
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
