/**
 * Chargeback (dispute) lifecycle.
 *
 * A dispute is the one money event the operator does not initiate: the
 * cardholder tells their bank the charge was wrong, the processor pulls the
 * funds back immediately, and weeks later it resolves for one side or the other.
 * LOCAL-FIRST-BUILD §5 puts "chargeback handling" in Phase 1 because a booking
 * system that cannot represent held funds will quietly report money it does not
 * have.
 *
 * THE MONEY MODEL, which is the whole point:
 *
 *   opened  — the processor has taken the money back pending the outcome. The
 *             Payment goes DISPUTED and the order's `amount_paid_cents` drops by
 *             the disputed amount, so its balance due reappears. The Payment's
 *             `refunded_cents` is deliberately NOT touched: nothing has been
 *             returned to the customer yet, and if we win it never will be.
 *   won     — the hold is released. The order's amount paid goes back up, the
 *             Payment returns to PAID (or PARTIAL_REFUND if it had refunds).
 *   lost    — the hold becomes permanent. The order stays where opening left it,
 *             and the Payment's `refunded_cents` finally absorbs the amount so
 *             that `amount_cents - refunded_cents` — which every report treats as
 *             net collected — stops counting money we no longer have.
 *
 * That gap between "opened" and "resolved" is real, not an accounting trick: it
 * is exactly the variance the reconciliation report surfaces as funds the
 * processor is holding.
 *
 * WHERE IT IS STORED: on the order's event history, not a table of its own.
 * `DISPUTE_OPENED` / `DISPUTE_EVIDENCE` / `DISPUTE_WON` / `DISPUTE_LOST`
 * OrderEvents are append-only, which is the right shape for something that is
 * legally a paper trail — `foldDisputes` replays them into current state. If a
 * dedicated `Dispute` model is ever added, this module's public surface is what
 * it has to keep.
 *
 * All money is integer cents; all times are UTC.
 */
import { Prisma, withTenant, forOperator, type TenantClient } from '@marina/database';
import { createId, formatUSD } from '@marina/core';
import { AUDIT_ACTIONS, SYSTEM_ACTOR, recordAudit, type AuditActor } from './audit.js';

/** A typed, user-facing failure that route handlers map to a clean HTTP status. */
export class DisputeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'DisputeError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * Where a dispute stands.
 *   OPEN         — funds held, nothing submitted yet.
 *   UNDER_REVIEW — we have submitted evidence and are waiting on the bank.
 *   WON          — the charge stands; the hold is released.
 *   LOST         — the cardholder keeps the money.
 */
export type DisputeStatus = 'OPEN' | 'UNDER_REVIEW' | 'WON' | 'LOST';

/** OrderEvent `type` values that make up a dispute's history. */
export const DISPUTE_EVENT_TYPES = {
  OPENED: 'DISPUTE_OPENED',
  EVIDENCE: 'DISPUTE_EVIDENCE',
  WON: 'DISPUTE_WON',
  LOST: 'DISPUTE_LOST',
} as const;

const ALL_DISPUTE_EVENT_TYPES: string[] = Object.values(DISPUTE_EVENT_TYPES);

/** Fields every dispute-event read selects — exactly what `foldDisputes` needs. */
const DISPUTE_EVENT_SELECT = {
  operator_id: true,
  order_id: true,
  type: true,
  actor: true,
  created_at: true,
  metadata: true,
} as const;

/**
 * Why the cardholder says the charge was wrong. Stripe's reason codes verbatim,
 * because an operator who later opens their processor dashboard should see the
 * same words.
 */
export const DISPUTE_REASONS = [
  'fraudulent',
  'duplicate',
  'product_not_received',
  'product_unacceptable',
  'subscription_canceled',
  'unrecognized',
  'credit_not_processed',
  'general',
] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

/** One piece of evidence the operator filed, in the order it was filed. */
export interface DisputeEvidence {
  at: Date;
  actor: string | null;
  /** What kind of proof this is: receipt, waiver, communication, policy, other. */
  kind: string;
  text: string;
}

/** A dispute, replayed from its event history. */
export interface Dispute {
  id: string;
  operatorId: string;
  orderId: string;
  paymentId: string;
  /** The processor's own dispute id (`dp_...`), when it came from a processor event. */
  externalId: string | null;
  /** The PaymentIntent the chargeback landed on, when known. */
  intentId: string | null;
  status: DisputeStatus;
  reason: string;
  /** Amount the processor pulled back, integer cents. */
  amountCents: number;
  openedAt: Date;
  /** When the bank's decision landed. Null while open. */
  resolvedAt: Date | null;
  /** Operator deadline to respond, when the processor gave one. */
  evidenceDueAt: Date | null;
  evidence: DisputeEvidence[];
  /** True while the money is out of the operator's hands and unresolved. */
  fundsHeld: boolean;
}

/** The minimal OrderEvent row `foldDisputes` needs. Keeps the fold DB-free and testable. */
export interface DisputeEventRow {
  operator_id: string;
  order_id: string;
  type: string;
  actor: string | null;
  created_at: Date;
  metadata: unknown;
}

// ---------------------------------------------------------------------------
// Folding events into state
// ---------------------------------------------------------------------------

function meta(row: DisputeEventRow): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0;
}

function date(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Replay dispute events into current state. Pure, so the state machine is
 * unit-testable without a database, and so a caller that already has the events
 * (an order detail page) does not have to re-query.
 *
 * Rows may arrive in any order; they are sorted by `created_at` first. An event
 * whose `disputeId` never had an opening row is ignored rather than inventing a
 * half-formed dispute — the history is append-only, so the alternative would be
 * to render a resolution with no amount attached to it.
 */
export function foldDisputes(rows: readonly DisputeEventRow[]): Dispute[] {
  const ordered = [...rows]
    .filter((r) => ALL_DISPUTE_EVENT_TYPES.includes(r.type))
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

  const byId = new Map<string, Dispute>();

  for (const row of ordered) {
    const m = meta(row);
    const id = str(m.disputeId);
    if (!id) continue;

    if (row.type === DISPUTE_EVENT_TYPES.OPENED) {
      if (byId.has(id)) continue; // append-only: the first opening wins
      byId.set(id, {
        id,
        operatorId: row.operator_id,
        orderId: row.order_id,
        paymentId: str(m.paymentId) ?? '',
        externalId: str(m.externalId),
        intentId: str(m.intentId),
        status: 'OPEN',
        reason: str(m.reason) ?? 'general',
        amountCents: int(m.amountCents),
        openedAt: row.created_at,
        resolvedAt: null,
        evidenceDueAt: date(m.evidenceDueAt),
        evidence: [],
        fundsHeld: true,
      });
      continue;
    }

    const dispute = byId.get(id);
    if (!dispute) continue;

    switch (row.type) {
      case DISPUTE_EVENT_TYPES.EVIDENCE:
        dispute.evidence.push({
          at: row.created_at,
          actor: row.actor,
          kind: str(m.kind) ?? 'other',
          text: str(m.text) ?? '',
        });
        // Evidence after a decision is a late filing, not a reopening.
        if (dispute.status === 'OPEN') dispute.status = 'UNDER_REVIEW';
        break;
      case DISPUTE_EVENT_TYPES.WON:
        dispute.status = 'WON';
        dispute.resolvedAt = row.created_at;
        dispute.fundsHeld = false;
        break;
      case DISPUTE_EVENT_TYPES.LOST:
        dispute.status = 'LOST';
        dispute.resolvedAt = row.created_at;
        dispute.fundsHeld = false;
        break;
    }
  }

  return [...byId.values()].sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
}

/** True while the processor is holding the money and the outcome is unknown. */
export function isUnresolved(status: DisputeStatus): boolean {
  return status === 'OPEN' || status === 'UNDER_REVIEW';
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListDisputesOptions {
  orderId?: string;
  paymentId?: string;
  status?: DisputeStatus | DisputeStatus[];
  /** Opened on or after this instant. */
  since?: Date;
  /** Opened strictly before this instant. */
  until?: Date;
}

/**
 * Every dispute matching the filter, newest first. Tenant-scoped through
 * `forOperator`, so RLS bounds it regardless of the filter.
 *
 * `since`/`until` filter the underlying events, not the folded disputes, so a
 * dispute opened before the window but resolved inside it still comes back
 * complete — a reconciliation report needs the whole story of a dispute that
 * touched its period, not the slice that happens to fall in it.
 */
export async function listDisputes(
  operatorId: string,
  options: ListDisputesOptions = {},
): Promise<Dispute[]> {
  const db = forOperator(operatorId);

  const where: Prisma.OrderEventWhereInput = {
    operator_id: operatorId,
    type: { in: ALL_DISPUTE_EVENT_TYPES },
    ...(options.orderId ? { order_id: options.orderId } : {}),
  };

  const rows = await db.orderEvent.findMany({
    where,
    select: DISPUTE_EVENT_SELECT,
    orderBy: { created_at: 'asc' },
  });

  let disputes = foldDisputes(rows);

  if (options.paymentId) {
    disputes = disputes.filter((d) => d.paymentId === options.paymentId);
  }
  if (options.status) {
    const wanted = Array.isArray(options.status) ? options.status : [options.status];
    disputes = disputes.filter((d) => wanted.includes(d.status));
  }
  if (options.since) {
    const since = options.since.getTime();
    disputes = disputes.filter(
      (d) => d.openedAt.getTime() >= since || (d.resolvedAt?.getTime() ?? 0) >= since,
    );
  }
  if (options.until) {
    const until = options.until.getTime();
    disputes = disputes.filter((d) => d.openedAt.getTime() < until);
  }
  return disputes;
}

/**
 * Which order a dispute lives on. Only opening events are scanned — there is one
 * per dispute and disputes are rare, so this stays a small read no matter how
 * long the order history gets. (Deliberately not a JSON-path `where`: this keeps
 * working on any Prisma/Postgres combination.)
 */
async function findDisputeOrderId(
  db: Prisma.TransactionClient | TenantClient,
  operatorId: string,
  disputeId: string,
): Promise<string | null> {
  const openings = await db.orderEvent.findMany({
    where: { operator_id: operatorId, type: DISPUTE_EVENT_TYPES.OPENED },
    select: { order_id: true, metadata: true },
  });
  const match = openings.find((row) => {
    const m = row.metadata;
    return (
      !!m && typeof m === 'object' && (m as Record<string, unknown>).disputeId === disputeId
    );
  });
  return match?.order_id ?? null;
}

/** One dispute by id, or null. */
export async function getDispute(operatorId: string, disputeId: string): Promise<Dispute | null> {
  const db = forOperator(operatorId);
  const orderId = await findDisputeOrderId(db, operatorId, disputeId);
  if (!orderId) return null;
  const disputes = await listDisputes(operatorId, { orderId });
  return disputes.find((d) => d.id === disputeId) ?? null;
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

export interface OpenDisputeInput {
  paymentId: string;
  /** Defaults to everything still outstanding on the payment. */
  amountCents?: number;
  reason?: DisputeReason | string;
  /** The processor's dispute id, when a processor event drove this. */
  externalId?: string | null;
  /** Operator's deadline to respond. */
  evidenceDueAt?: Date | null;
  /** Where this came from: a processor notification, or someone typing it in. */
  source?: 'processor' | 'manual';
  actor?: AuditActor;
}

/**
 * Open a chargeback against a payment: hold the funds, mark the payment
 * DISPUTED, and put the order's balance back. Runs in one tenant transaction so
 * the payment and the order can never disagree about whether the money is held.
 *
 * Idempotent on `externalId`: a processor that delivers `charge.dispute.created`
 * twice (or a webhook replayed from the Local Console) must not hold the funds
 * twice, so the second call returns the dispute that already exists.
 */
export async function openDispute(
  operatorId: string,
  input: OpenDisputeInput,
): Promise<Dispute> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const reason = input.reason ?? 'general';
  const source = input.source ?? 'processor';

  const outcome = await withTenant(operatorId, async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: input.paymentId, operator_id: operatorId },
      select: {
        id: true,
        order_id: true,
        method: true,
        status: true,
        amount_cents: true,
        refunded_cents: true,
        processor_transaction_id: true,
      },
    });
    if (!payment) {
      throw new DisputeError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
    }

    // Only a card charge can be charged back. Cash, comps and gift-card
    // redemptions have no issuer to dispute to, and letting one through here
    // would silently unbalance the order.
    if (payment.method !== 'CARD') {
      throw new DisputeError(
        'NOT_DISPUTABLE',
        `A ${payment.method.toLowerCase().replace('_', ' ')} payment cannot be charged back`,
        409,
      );
    }
    if (payment.status === 'FAILED' || payment.status === 'REQUIRES_ACTION') {
      throw new DisputeError(
        'NOT_DISPUTABLE',
        'This payment never captured, so there is nothing to dispute',
        409,
      );
    }

    // Idempotency: an already-recorded dispute with this processor id wins.
    const existingEvents = await tx.orderEvent.findMany({
      where: {
        operator_id: operatorId,
        order_id: payment.order_id,
        type: { in: ALL_DISPUTE_EVENT_TYPES },
      },
      select: DISPUTE_EVENT_SELECT,
      orderBy: { created_at: 'asc' },
    });
    const existing = foldDisputes(existingEvents);
    if (input.externalId) {
      const already = existing.find((d) => d.externalId === input.externalId);
      if (already) return { dispute: already, replayed: true as const };
    }
    const openOnPayment = existing.find(
      (d) => d.paymentId === payment.id && isUnresolved(d.status),
    );
    if (openOnPayment) {
      throw new DisputeError(
        'DISPUTE_ALREADY_OPEN',
        'This payment already has an open dispute',
        409,
      );
    }

    // What is actually at stake: the captured amount less anything already
    // refunded, less anything a previous lost dispute took.
    const disputable = payment.amount_cents - payment.refunded_cents;
    if (disputable <= 0) {
      throw new DisputeError(
        'NOTHING_TO_DISPUTE',
        'This payment has already been fully returned',
        409,
      );
    }
    const amountCents = input.amountCents ?? disputable;
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new DisputeError('INVALID_AMOUNT', 'Dispute amount must be a positive whole number of cents');
    }
    if (amountCents > disputable) {
      throw new DisputeError(
        'INVALID_AMOUNT',
        `Dispute exceeds the ${formatUSD(disputable)} still outstanding on this payment`,
      );
    }

    const order = await tx.order.findFirst({
      where: { id: payment.order_id, operator_id: operatorId },
      select: {
        id: true,
        order_number: true,
        total_cents: true,
        amount_paid_cents: true,
        balance_due_cents: true,
      },
    });
    if (!order) {
      throw new DisputeError('ORDER_NOT_FOUND', 'Order not found for this payment', 404);
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'DISPUTED' },
    });

    // Same roll-back the refund path uses, so held and refunded money move the
    // order's balance in exactly one way.
    const newAmountPaid = Math.max(0, order.amount_paid_cents - amountCents);
    const newBalanceDue = order.total_cents - newAmountPaid;
    await tx.order.update({
      where: { id: order.id },
      data: { amount_paid_cents: newAmountPaid, balance_due_cents: newBalanceDue },
    });

    const disputeId = `dsp_${createId()}`;
    const event = await tx.orderEvent.create({
      data: {
        id: createId(),
        operator_id: operatorId,
        order_id: order.id,
        type: DISPUTE_EVENT_TYPES.OPENED,
        description: `Chargeback opened for ${formatUSD(amountCents)} — ${reason}`,
        actor: actor.id,
        metadata: {
          disputeId,
          externalId: input.externalId ?? null,
          paymentId: payment.id,
          intentId: payment.processor_transaction_id,
          amountCents,
          reason,
          source,
          evidenceDueAt: input.evidenceDueAt ? input.evidenceDueAt.toISOString() : null,
        } as Prisma.InputJsonValue,
      },
      select: { created_at: true },
    });

    const dispute: Dispute = {
      id: disputeId,
      operatorId,
      orderId: order.id,
      paymentId: payment.id,
      externalId: input.externalId ?? null,
      intentId: payment.processor_transaction_id,
      status: 'OPEN',
      reason: String(reason),
      amountCents,
      openedAt: event.created_at,
      resolvedAt: null,
      evidenceDueAt: input.evidenceDueAt ?? null,
      evidence: [],
      fundsHeld: true,
    };

    return {
      dispute,
      replayed: false as const,
      audit: {
        before: {
          payment_status: payment.status,
          amount_paid_cents: order.amount_paid_cents,
          balance_due_cents: order.balance_due_cents,
        },
        after: {
          payment_status: 'DISPUTED',
          amount_paid_cents: newAmountPaid,
          balance_due_cents: newBalanceDue,
        },
        orderNumber: order.order_number,
      },
    };
  });

  if (outcome.replayed) return outcome.dispute;

  await recordAudit({
    operatorId,
    actor,
    action: AUDIT_ACTIONS.PAYMENT_CHARGEBACK,
    entityType: 'Payment',
    entityId: outcome.dispute.paymentId,
    before: outcome.audit.before,
    after: outcome.audit.after,
    context: {
      stage: 'opened',
      disputeId: outcome.dispute.id,
      externalId: outcome.dispute.externalId,
      orderNumber: outcome.audit.orderNumber,
      amountCents: outcome.dispute.amountCents,
      reason: outcome.dispute.reason,
      source,
    },
  });

  return outcome.dispute;
}

/**
 * Open a dispute identified by the PaymentIntent it landed on rather than by our
 * Payment id — the way a processor names it. Used by the webhook path.
 */
export async function openDisputeForIntent(
  operatorId: string,
  input: Omit<OpenDisputeInput, 'paymentId'> & { intentId: string },
): Promise<Dispute> {
  const db = forOperator(operatorId);
  const payment = await db.payment.findFirst({
    where: { operator_id: operatorId, processor_transaction_id: input.intentId },
    select: { id: true },
    orderBy: { processed_at: 'desc' },
  });
  if (!payment) {
    throw new DisputeError(
      'PAYMENT_NOT_FOUND',
      `No payment recorded for processor transaction ${input.intentId}`,
      404,
    );
  }
  return openDispute(operatorId, { ...input, paymentId: payment.id });
}

/**
 * Handle a `charge.dispute.created` event.
 *
 * This is the seam to the local payment simulator: forcing the DISPUTED outcome
 * in the Local Console (or calling its `disputePayment`) emits exactly this
 * event shape — Stripe's Dispute object — and the cloud driver emits the same
 * one, so the ledger effect is identical whichever driver produced it.
 *
 * Returns null when the event names a charge we have no Payment for, rather than
 * throwing: an unmatched processor event is a reconciliation finding, not a
 * webhook failure to retry forever.
 */
export async function handleDisputeCreatedEvent(
  operatorId: string,
  disputeObject: unknown,
): Promise<Dispute | null> {
  const d =
    disputeObject && typeof disputeObject === 'object'
      ? (disputeObject as Record<string, unknown>)
      : {};
  const intentId = str(d.payment_intent);
  if (!intentId) {
    throw new DisputeError('INVALID_EVENT', 'Dispute event has no payment_intent', 400);
  }

  const amount = typeof d.amount === 'number' && Number.isSafeInteger(d.amount) ? d.amount : undefined;
  // Stripe sends `evidence_details.due_by` as epoch seconds.
  const details =
    d.evidence_details && typeof d.evidence_details === 'object'
      ? (d.evidence_details as Record<string, unknown>)
      : {};
  const dueBy = typeof details.due_by === 'number' ? new Date(details.due_by * 1000) : null;

  try {
    return await openDisputeForIntent(operatorId, {
      intentId,
      amountCents: amount,
      reason: str(d.reason) ?? 'general',
      externalId: str(d.id),
      evidenceDueAt: dueBy,
      source: 'processor',
    });
  } catch (err) {
    if (err instanceof DisputeError && err.code === 'PAYMENT_NOT_FOUND') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface RecordEvidenceInput {
  disputeId: string;
  /** receipt, waiver, communication, policy, other — free-form but conventional. */
  kind?: string;
  text: string;
  actor?: AuditActor;
}

/**
 * File a piece of evidence against an open dispute. Append-only: evidence is
 * never edited or removed, because its whole value is being able to show what
 * was submitted and when. The first filing moves the dispute to UNDER_REVIEW.
 */
export async function recordEvidence(
  operatorId: string,
  input: RecordEvidenceInput,
): Promise<Dispute> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const text = input.text.trim();
  if (!text) {
    throw new DisputeError('EMPTY_EVIDENCE', 'Evidence cannot be blank');
  }

  const dispute = await getDispute(operatorId, input.disputeId);
  if (!dispute) {
    throw new DisputeError('DISPUTE_NOT_FOUND', 'Dispute not found', 404);
  }
  if (!isUnresolved(dispute.status)) {
    throw new DisputeError(
      'DISPUTE_RESOLVED',
      `This dispute was already ${dispute.status.toLowerCase()} — evidence can no longer change it`,
      409,
    );
  }

  const kind = (input.kind ?? 'other').trim() || 'other';
  const db = forOperator(operatorId);
  const event = await db.orderEvent.create({
    data: {
      id: createId(),
      operator_id: operatorId,
      order_id: dispute.orderId,
      type: DISPUTE_EVENT_TYPES.EVIDENCE,
      description: `Dispute evidence filed (${kind})`,
      actor: actor.id,
      metadata: {
        disputeId: dispute.id,
        paymentId: dispute.paymentId,
        kind,
        text,
      } as Prisma.InputJsonValue,
    },
    select: { created_at: true },
  });

  await recordAudit({
    operatorId,
    actor,
    action: AUDIT_ACTIONS.PAYMENT_CHARGEBACK,
    entityType: 'Payment',
    entityId: dispute.paymentId,
    after: { evidence_count: dispute.evidence.length + 1 },
    context: { stage: 'evidence', disputeId: dispute.id, kind },
  });

  return {
    ...dispute,
    status: 'UNDER_REVIEW',
    evidence: [...dispute.evidence, { at: event.created_at, actor: actor.id, kind, text }],
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveDisputeInput {
  disputeId: string;
  outcome: 'WON' | 'LOST';
  /** Why the bank decided as it did, for the order history. */
  note?: string;
  actor?: AuditActor;
}

/**
 * Close a dispute and settle the money.
 *
 * WON releases the hold: the order's amount paid goes back up and the payment
 * returns to PAID (or PARTIAL_REFUND if it was partly refunded before the
 * dispute). LOST makes the hold permanent by moving the amount into the
 * payment's `refunded_cents`, which is what every net-collected figure in the
 * product reads — the order needs no further change because opening the dispute
 * already took the money off it.
 *
 * Both branches run in one tenant transaction: a half-applied resolution would
 * leave the order and the payment permanently disagreeing.
 */
export async function resolveDispute(
  operatorId: string,
  input: ResolveDisputeInput,
): Promise<Dispute> {
  const actor = input.actor ?? SYSTEM_ACTOR;

  const outcome = await withTenant(operatorId, async (tx) => {
    // Re-read the history inside the transaction: two staff resolving the same
    // dispute at once must not both settle the money.
    const orderId = await findDisputeOrderId(tx, operatorId, input.disputeId);
    const events = orderId
      ? await tx.orderEvent.findMany({
          where: {
            operator_id: operatorId,
            order_id: orderId,
            type: { in: ALL_DISPUTE_EVENT_TYPES },
          },
          select: DISPUTE_EVENT_SELECT,
          orderBy: { created_at: 'asc' },
        })
      : [];
    const dispute = foldDisputes(events).find((d) => d.id === input.disputeId);
    if (!dispute) {
      throw new DisputeError('DISPUTE_NOT_FOUND', 'Dispute not found', 404);
    }
    if (!isUnresolved(dispute.status)) {
      throw new DisputeError(
        'DISPUTE_RESOLVED',
        `This dispute is already ${dispute.status.toLowerCase()}`,
        409,
      );
    }

    const payment = await tx.payment.findFirst({
      where: { id: dispute.paymentId, operator_id: operatorId },
      select: { id: true, status: true, amount_cents: true, refunded_cents: true },
    });
    if (!payment) {
      throw new DisputeError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
    }
    const order = await tx.order.findFirst({
      where: { id: dispute.orderId, operator_id: operatorId },
      select: {
        id: true,
        order_number: true,
        total_cents: true,
        amount_paid_cents: true,
        balance_due_cents: true,
      },
    });
    if (!order) {
      throw new DisputeError('ORDER_NOT_FOUND', 'Order not found for this dispute', 404);
    }

    const before = {
      payment_status: payment.status,
      refunded_cents: payment.refunded_cents,
      amount_paid_cents: order.amount_paid_cents,
      balance_due_cents: order.balance_due_cents,
    };

    let after: typeof before;

    if (input.outcome === 'WON') {
      // The charge stands. Put the money back exactly where opening took it from.
      const newAmountPaid = Math.min(
        order.total_cents,
        order.amount_paid_cents + dispute.amountCents,
      );
      const newBalanceDue = order.total_cents - newAmountPaid;
      const restoredStatus = payment.refunded_cents > 0 ? 'PARTIAL_REFUND' : 'PAID';

      await tx.payment.update({
        where: { id: payment.id },
        data: { status: restoredStatus },
      });
      await tx.order.update({
        where: { id: order.id },
        data: { amount_paid_cents: newAmountPaid, balance_due_cents: newBalanceDue },
      });
      after = {
        payment_status: restoredStatus,
        refunded_cents: payment.refunded_cents,
        amount_paid_cents: newAmountPaid,
        balance_due_cents: newBalanceDue,
      };
    } else {
      // The money is gone. Fold it into refunded_cents so net collected is right,
      // and leave the order as the hold left it — the balance is genuinely unpaid.
      const newRefunded = Math.min(payment.amount_cents, payment.refunded_cents + dispute.amountCents);
      await tx.payment.update({
        where: { id: payment.id },
        // Status stays DISPUTED rather than REFUNDED: a lost chargeback is not a
        // refund the operator chose to give, and the two are read differently by
        // the reconciliation report and by any future representment.
        data: { refunded_cents: newRefunded },
      });
      after = {
        payment_status: payment.status,
        refunded_cents: newRefunded,
        amount_paid_cents: order.amount_paid_cents,
        balance_due_cents: order.balance_due_cents,
      };
    }

    const event = await tx.orderEvent.create({
      data: {
        id: createId(),
        operator_id: operatorId,
        order_id: order.id,
        type:
          input.outcome === 'WON' ? DISPUTE_EVENT_TYPES.WON : DISPUTE_EVENT_TYPES.LOST,
        description:
          input.outcome === 'WON'
            ? `Chargeback of ${formatUSD(dispute.amountCents)} resolved in your favour — funds released`
            : `Chargeback of ${formatUSD(dispute.amountCents)} lost — funds withdrawn`,
        actor: actor.id,
        metadata: {
          disputeId: dispute.id,
          paymentId: dispute.paymentId,
          amountCents: dispute.amountCents,
          note: input.note ?? null,
        } as Prisma.InputJsonValue,
      },
      select: { created_at: true },
    });

    const resolved: Dispute = {
      ...dispute,
      status: input.outcome,
      resolvedAt: event.created_at,
      fundsHeld: false,
    };

    return { dispute: resolved, before, after, orderNumber: order.order_number };
  });

  await recordAudit({
    operatorId,
    actor,
    action: AUDIT_ACTIONS.PAYMENT_CHARGEBACK,
    entityType: 'Payment',
    entityId: outcome.dispute.paymentId,
    before: outcome.before,
    after: outcome.after,
    context: {
      stage: 'resolved',
      outcome: input.outcome,
      disputeId: outcome.dispute.id,
      orderNumber: outcome.orderNumber,
      amountCents: outcome.dispute.amountCents,
      note: input.note ?? null,
    },
  });

  return outcome.dispute;
}

// ---------------------------------------------------------------------------
// Exposure
// ---------------------------------------------------------------------------

/** What disputes are costing the operator right now. */
export interface DisputeExposure {
  /** Funds the processor is holding on unresolved disputes. */
  heldCents: number;
  openCount: number;
  /** Money lost to chargebacks that resolved against the operator. */
  lostCents: number;
  lostCount: number;
  /** Held money that came back after a win. */
  wonCents: number;
  wonCount: number;
}

/** Roll a set of disputes into the exposure figures the dashboard shows. Pure. */
export function summarizeDisputes(disputes: readonly Dispute[]): DisputeExposure {
  const out: DisputeExposure = {
    heldCents: 0,
    openCount: 0,
    lostCents: 0,
    lostCount: 0,
    wonCents: 0,
    wonCount: 0,
  };
  for (const d of disputes) {
    if (isUnresolved(d.status)) {
      out.heldCents += d.amountCents;
      out.openCount += 1;
    } else if (d.status === 'LOST') {
      out.lostCents += d.amountCents;
      out.lostCount += 1;
    } else {
      out.wonCents += d.amountCents;
      out.wonCount += 1;
    }
  }
  return out;
}
