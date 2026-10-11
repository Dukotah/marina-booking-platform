import { AlertTriangle } from 'lucide-react';
import { AuthorizationError } from '@marina/auth';
import { Button, EmptyState } from '@marina/ui';
import { AdminShell } from '../../../components/shell/AdminShell';
import { PageHeader } from '../../../components/shell';
import { getOperatorContext, getTenantDb, requirePermission } from '../../../lib/session';
import { formatUSD } from '../../../lib/format';
import {
  ReconciliationView,
  type ReconciliationDay,
  type ReconciliationReport,
  type ReconciliationVariance,
  type NonCardTotal,
} from '../../../components/reports/ReconciliationView';

export const metadata = {
  title: 'Reconciliation',
};

/** Live, session/search-param dependent — always render fresh. */
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// ---------------------------------------------------------------------------
// Date helpers
//
// Local ISO days, matching `components/reports/queries.ts` exactly so a day on
// this report is the same day as on the revenue report. Duplicated rather than
// imported because queries.ts is `server-only` shared infrastructure and this
// report owns its own data path.
// ---------------------------------------------------------------------------

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Resolve `from`/`to` into an ordered half-open window, defaulting to the last 30 days. */
function resolveRange(rawFrom?: string, rawTo?: string) {
  const isIso = (s?: string): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const today = startOfDay(new Date());
  let start = isIso(rawFrom) ? parseIsoDate(rawFrom) : addDays(today, -29);
  let end = isIso(rawTo) ? parseIsoDate(rawTo) : today;
  if (start.getTime() > end.getTime()) [start, end] = [end, start];
  const endExclusive = addDays(end, 1);
  return { from: isoDate(start), to: isoDate(end), start, endExclusive };
}

// ---------------------------------------------------------------------------
// Reading loosely-typed metadata
// ---------------------------------------------------------------------------

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

/**
 * Payment statuses where money was actually captured. PRE_AUTHORIZED holds a card
 * without taking anything and FAILED / REQUIRES_ACTION never moved money, so
 * counting any of them as collected would create a variance out of thin air.
 */
const CAPTURED_STATUSES: readonly string[] = ['PAID', 'PARTIAL_REFUND', 'REFUNDED', 'DISPUTED'];

/** True when this payment's status means money actually landed. */
function isCaptured(status: string): boolean {
  return CAPTURED_STATUSES.includes(status);
}

const DISPUTE_EVENT_TYPES = ['DISPUTE_OPENED', 'DISPUTE_WON', 'DISPUTE_LOST'];

const NON_CARD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  GIFT_CARD: 'Gift card',
  COMP: 'Comp',
};

/**
 * A dispute as this report needs it. The authoritative lifecycle lives in
 * `apps/api/src/services/disputes.ts`, but the admin app cannot import from the
 * API app, so the events are re-read here. Only the three fields the
 * reconciliation needs are reconstructed — amount, which intent it hit, and
 * whether it is still holding money.
 */
interface DisputeRecord {
  id: string;
  intentId: string | null;
  paymentId: string | null;
  orderId: string;
  orderNumber: string | null;
  amountCents: number;
  openedAt: Date;
  resolvedAt: Date | null;
  outcome: 'OPEN' | 'WON' | 'LOST';
}

/** One dated money movement on one side of the reconciliation. */
interface Movement {
  date: string;
  cents: number;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

async function buildReconciliation(rawFrom?: string, rawTo?: string): Promise<ReconciliationReport> {
  const { from, to, start, endExclusive } = resolveRange(rawFrom, rawTo);
  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();

  const inRange = (d: Date | null | undefined): boolean =>
    !!d && d.getTime() >= start.getTime() && d.getTime() < endExclusive.getTime();

  // --- Our ledger -----------------------------------------------------------

  const payments = await db.payment.findMany({
    where: { operator_id: operatorId, processed_at: { gte: start, lt: endExclusive } },
    select: {
      id: true,
      order_id: true,
      method: true,
      status: true,
      amount_cents: true,
      refunded_cents: true,
      processor_transaction_id: true,
      processed_at: true,
      order: { select: { order_number: true } },
    },
    orderBy: { processed_at: 'asc' },
  });

  const refundEvents = await db.orderEvent.findMany({
    where: {
      operator_id: operatorId,
      type: 'REFUND',
      created_at: { gte: start, lt: endExclusive },
    },
    select: { created_at: true, metadata: true },
    orderBy: { created_at: 'asc' },
  });

  // Dispute history is read in full, not just for the range: a chargeback opened
  // last month and lost today has to be understood on both days.
  const disputeEvents = await db.orderEvent.findMany({
    where: { operator_id: operatorId, type: { in: DISPUTE_EVENT_TYPES } },
    select: {
      order_id: true,
      type: true,
      created_at: true,
      metadata: true,
      order: { select: { order_number: true } },
    },
    orderBy: { created_at: 'asc' },
  });

  const disputes = foldDisputeRecords(disputeEvents);

  // --- The processor's own ledger ------------------------------------------

  const cardPayments = payments.filter(
    (p) => p.method === 'CARD' && isCaptured(p.status),
  );
  const rangeIntentIds = cardPayments
    .map((p) => p.processor_transaction_id)
    .filter((id): id is string => !!id);

  let attempts: SandboxAttemptRow[] = [];
  let processorUnavailable = false;
  try {
    attempts = (await db.sandboxPaymentAttempt.findMany({
      where: {
        operator_id: operatorId,
        status: { in: ['SUCCEEDED', 'DISPUTED'] },
        OR: [
          { consumed_at: { gte: start, lt: endExclusive } },
          { AND: [{ consumed_at: null }, { created_at: { gte: start, lt: endExclusive } }] },
          // Plus every attempt an in-range payment points at, so a charge taken
          // just before midnight still matches the record it created.
          ...(rangeIntentIds.length ? [{ intent_id: { in: rangeIntentIds } }] : []),
        ],
      },
      select: {
        id: true,
        intent_id: true,
        amount_cents: true,
        status: true,
        order_id: true,
        metadata: true,
        consumed_at: true,
        created_at: true,
      },
      orderBy: { created_at: 'asc' },
    })) as SandboxAttemptRow[];
    const attemptOrderIds = [
      ...new Set(attempts.map((a) => a.order_id).filter((id): id is string => Boolean(id))),
    ];
    if (attemptOrderIds.length > 0) {
      const rows = await db.order.findMany({
        where: { id: { in: attemptOrderIds } },
        select: { id: true, order_number: true },
      });
      const byId = new Map(rows.map((o) => [o.id, o.order_number]));
      attempts = attempts.map((a) => ({
        ...a,
        orderNumber: a.order_id ? (byId.get(a.order_id) ?? null) : null,
      }));
    }
  } catch {
    // The sandbox tables are the local driver's ledger. In cloud mode they are
    // empty (or absent), which is not an error — it means there is no statement
    // to reconcile against yet.
    processorUnavailable = true;
  }

  // Payments the attempts point at, whenever they were taken — needed to tell
  // "the processor has a charge we never recorded" apart from "we recorded it
  // on the other side of midnight".
  const attemptIntentIds = attempts
    .map((a) => a.intent_id)
    .filter((id): id is string => !!id);
  const linkedPayments = attemptIntentIds.length
    ? await db.payment.findMany({
        where: {
          operator_id: operatorId,
          processor_transaction_id: { in: attemptIntentIds },
        },
        select: {
          id: true,
          method: true,
          status: true,
          processor_transaction_id: true,
          processed_at: true,
        },
      })
    : [];
  // Only a captured card payment counts as "we recorded it" — a FAILED row sitting
  // against a settled charge is exactly the gap this report exists to show.
  const paymentByIntent = new Map<string, { id: string; processed_at: Date }>();
  for (const p of linkedPayments) {
    if (p.processor_transaction_id && p.method === 'CARD' && isCaptured(p.status)) {
      paymentByIntent.set(p.processor_transaction_id, { id: p.id, processed_at: p.processed_at });
    }
  }

  const attemptByIntent = new Map<string, SandboxAttemptRow>();
  for (const a of attempts) {
    if (a.intent_id) attemptByIntent.set(a.intent_id, a);
  }

  // --- Movements ------------------------------------------------------------

  const ledgerCharges: Movement[] = [];
  const ledgerRefunds: Movement[] = [];
  const ledgerChargebacks: Movement[] = [];
  const processorCaptures: Movement[] = [];
  const processorRefunds: Movement[] = [];
  const processorDisputes: Movement[] = [];
  const variances: ReconciliationVariance[] = [];

  for (const p of cardPayments) {
    ledgerCharges.push({ date: isoDate(p.processed_at), cents: p.amount_cents });
  }

  for (const e of refundEvents) {
    const m = obj(e.metadata);
    const cents = int(m.amountCents);
    if (cents > 0) ledgerRefunds.push({ date: isoDate(e.created_at), cents });
  }

  for (const d of disputes) {
    if (d.outcome === 'LOST' && inRange(d.resolvedAt)) {
      ledgerChargebacks.push({ date: isoDate(d.resolvedAt!), cents: d.amountCents });
      variances.push({
        id: `writeoff-${d.id}`,
        date: isoDate(d.resolvedAt!),
        kind: 'CHARGEBACK_WRITEOFF',
        orderId: d.orderId,
        orderNumber: d.orderNumber,
        paymentId: d.paymentId,
        intentId: d.intentId,
        ledgerCents: -d.amountCents,
        processorCents: 0,
        varianceCents: -d.amountCents,
        detail: `A chargeback was decided against you, so this ${formatUSD(d.amountCents)} came off our books today. The processor took it back when the dispute opened, so its side did not move.`,
        action: 'Nothing to do — the two ledgers are square again from today.',
      });
    }
    if (d.outcome === 'WON' && inRange(d.resolvedAt)) {
      processorDisputes.push({ date: isoDate(d.resolvedAt!), cents: d.amountCents });
      variances.push({
        id: `release-${d.id}`,
        date: isoDate(d.resolvedAt!),
        kind: 'DISPUTE_RELEASED',
        orderId: d.orderId,
        orderNumber: d.orderNumber,
        paymentId: d.paymentId,
        intentId: d.intentId,
        ledgerCents: 0,
        processorCents: d.amountCents,
        varianceCents: -d.amountCents,
        detail: `You won this dispute, so the processor returned ${formatUSD(d.amountCents)} it had been holding. We never stopped counting it, so only its side moved.`,
        action: 'Nothing to do — this cancels out the hold from when the dispute opened.',
      });
    }
  }

  const disputeByIntent = new Map<string, DisputeRecord>();
  for (const d of disputes) {
    if (d.intentId) disputeByIntent.set(d.intentId, d);
  }

  const matchedIntents = new Set<string>();

  for (const p of cardPayments) {
    const date = isoDate(p.processed_at);
    const orderNumber = p.order?.order_number ?? null;

    if (!p.processor_transaction_id) {
      variances.push({
        id: `unlinked-${p.id}`,
        date,
        kind: 'UNLINKED',
        orderId: p.order_id,
        orderNumber,
        paymentId: p.id,
        intentId: null,
        ledgerCents: p.amount_cents,
        processorCents: null,
        varianceCents: p.amount_cents,
        detail: `We recorded a ${formatUSD(p.amount_cents)} card payment with no processor reference on it, so there is nothing to match it against.`,
        action: 'Check how this payment was taken — a card charge should always carry a processor transaction id.',
      });
      continue;
    }

    const attempt = attemptByIntent.get(p.processor_transaction_id);
    if (!attempt) {
      if (processorUnavailable) continue;
      variances.push({
        id: `missing-processor-${p.id}`,
        date,
        kind: 'MISSING_IN_PROCESSOR',
        orderId: p.order_id,
        orderNumber,
        paymentId: p.id,
        intentId: p.processor_transaction_id,
        ledgerCents: p.amount_cents,
        processorCents: null,
        varianceCents: p.amount_cents,
        detail: `We show ${formatUSD(p.amount_cents)} collected but the processor has no record of this charge.`,
        action: 'Confirm the charge really settled before you count it as revenue.',
      });
      continue;
    }

    matchedIntents.add(p.processor_transaction_id);
    const meta = obj(attempt.metadata);
    const captured = int(meta.capturedCents) || attempt.amount_cents || 0;
    if (captured !== p.amount_cents) {
      variances.push({
        id: `amount-${p.id}`,
        date,
        kind: 'AMOUNT_MISMATCH',
        orderId: p.order_id,
        orderNumber,
        paymentId: p.id,
        intentId: p.processor_transaction_id,
        ledgerCents: p.amount_cents,
        processorCents: captured,
        varianceCents: p.amount_cents - captured,
        detail: `We recorded ${formatUSD(p.amount_cents)} but the processor captured ${formatUSD(captured)} — usually a partial capture that was never written back to the payment.`,
        action: 'Correct the payment amount to what actually settled.',
      });
    }
  }

  // Refunds, compared as movements rather than as running totals so each one
  // lands on the day it happened.
  for (const attempt of attempts) {
    const meta = obj(attempt.metadata);
    const refunds = Array.isArray(meta.refunds) ? meta.refunds : [];
    for (const raw of refunds) {
      const r = obj(raw);
      const cents = int(r.amountCents);
      const at = asDate(r.at);
      if (cents > 0 && inRange(at)) {
        processorRefunds.push({ date: isoDate(at!), cents });
      }
    }

    const dispute = obj(meta.dispute);
    const disputeAt = asDate(dispute.at);
    const disputeCents = int(dispute.amountCents);
    if (disputeCents > 0 && inRange(disputeAt)) {
      processorDisputes.push({ date: isoDate(disputeAt!), cents: -disputeCents });
      const known = attempt.intent_id ? disputeByIntent.get(attempt.intent_id) : undefined;
      if (known) {
        variances.push({
          id: `held-${attempt.id}`,
          date: isoDate(disputeAt!),
          kind: 'DISPUTE_HELD',
          orderId: attempt.order_id,
          orderNumber: known.orderNumber ?? attempt.orderNumber ?? null,
          paymentId: known.paymentId,
          intentId: attempt.intent_id,
          ledgerCents: 0,
          processorCents: -disputeCents,
          varianceCents: disputeCents,
          detail: `A cardholder disputed this charge, so the processor pulled ${formatUSD(disputeCents)} back while the bank decides. We still count it as collected until the dispute resolves.`,
          action: 'File your evidence before the deadline; the gap closes when the dispute is won or lost.',
        });
      } else {
        variances.push({
          id: `unrecorded-dispute-${attempt.id}`,
          date: isoDate(disputeAt!),
          kind: 'DISPUTE_UNRECORDED',
          orderId: attempt.order_id,
          orderNumber: attempt.orderNumber ?? null,
          paymentId: null,
          intentId: attempt.intent_id,
          ledgerCents: 0,
          processorCents: -disputeCents,
          varianceCents: disputeCents,
          detail: `The processor took ${formatUSD(disputeCents)} back for a chargeback we have no record of.`,
          action: 'Record the chargeback against this payment so the order balance reflects the held funds.',
        });
      }
    }

    // Every captured attempt is money the processor says it took.
    const status = attempt.status;
    if (status === 'SUCCEEDED' || status === 'DISPUTED') {
      const settledAt = attempt.consumed_at ?? attempt.created_at;
      const captured = int(meta.capturedCents) || attempt.amount_cents || 0;
      if (captured > 0 && inRange(settledAt)) {
        processorCaptures.push({ date: isoDate(settledAt), cents: captured });
      }

      const linked = attempt.intent_id ? paymentByIntent.get(attempt.intent_id) : undefined;
      if (!linked && captured > 0 && inRange(settledAt)) {
        variances.push({
          id: `missing-ledger-${attempt.id}`,
          date: isoDate(settledAt),
          kind: 'MISSING_IN_LEDGER',
          orderId: attempt.order_id,
          orderNumber: attempt.orderNumber ?? null,
          paymentId: null,
          intentId: attempt.intent_id,
          ledgerCents: null,
          processorCents: captured,
          varianceCents: -captured,
          detail: `The processor took ${formatUSD(captured)} that never made it onto an order. This is what a timed-out charge looks like: the money moved, we never heard back.`,
          action: 'Find the order this belongs to and record the payment, or refund the customer.',
        });
      }
    }
  }

  // Our refunds vs theirs, per day. A day where the two disagree is either an
  // unrecorded refund or one the processor never processed.
  const ledgerRefundByDay = sumByDay(ledgerRefunds);
  const processorRefundByDay = sumByDay(processorRefunds);
  if (!processorUnavailable) {
    variances.push(...refundVariances(ledgerRefundByDay, processorRefundByDay));
  }

  // --- Roll up by day -------------------------------------------------------

  const days = buildDays({
    start,
    endExclusive,
    processorUnavailable,
    ledgerCharges,
    ledgerRefundByDay,
    ledgerChargebacks,
    processorCaptures,
    processorRefundByDay,
    processorDisputes,
  });

  // The invariant that makes this screen trustworthy: for every day, the
  // itemized reasons must add up to that day's variance. Anything left over is a
  // charge and its processor record landing on different days — say so, rather
  // than leaving an unexplained number on the screen.
  if (!processorUnavailable) {
    variances.push(...timingVariances(days, variances));
  }

  for (const day of days) {
    day.varianceCount = variances.filter((v) => v.date === day.date).length;
  }

  // --- Totals ---------------------------------------------------------------

  const ledgerNetCents = days.reduce((s, d) => s + d.ledgerNetCents, 0);
  const processorNetCents = days.reduce((s, d) => s + d.processorNetCents, 0);
  const heldCents = disputes
    .filter((d) => d.outcome === 'OPEN' && d.openedAt.getTime() < endExclusive.getTime())
    .reduce((s, d) => s + d.amountCents, 0);
  const chargebackCents = disputes
    .filter((d) => d.outcome === 'LOST' && inRange(d.resolvedAt))
    .reduce((s, d) => s + d.amountCents, 0);

  const nonCard = summarizeNonCard(payments);

  variances.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    range: { from, to },
    source: processorUnavailable ? 'none' : 'sandbox',
    sourceNote: processorUnavailable
      ? 'The local payment simulator keeps the processor side of this report. Run with SANDBOX=local to reconcile against it; a cloud processor statement importer is not built yet.'
      : null,
    totals: {
      ledgerNetCents,
      processorNetCents: processorUnavailable ? 0 : processorNetCents,
      varianceCents: processorUnavailable ? 0 : ledgerNetCents - processorNetCents,
      balanced: processorUnavailable ? true : ledgerNetCents === processorNetCents,
      matchedCount: matchedIntents.size,
      unmatchedCount: variances.filter(
        (v) => v.kind === 'MISSING_IN_LEDGER' || v.kind === 'MISSING_IN_PROCESSOR' || v.kind === 'UNLINKED',
      ).length,
      heldCents,
      chargebackCents,
    },
    days,
    variances,
    nonCard,
  };
}

/** The shape this report reads off a SandboxPaymentAttempt row. */
interface SandboxAttemptRow {
  id: string;
  intent_id: string | null;
  amount_cents: number | null;
  status: string;
  order_id: string | null;
  metadata: unknown;
  consumed_at: Date | null;
  created_at: Date;
  /**
   * Resolved separately: SandboxPaymentAttempt.order_id is a soft link with no
   * foreign key (a deposit is charged inside the transaction that creates its
   * order), so Prisma cannot join it.
   */
  orderNumber: string | null;
}

/**
 * Refunds compared day by day. Both sides are dated by when the refund actually
 * happened — ours by its OrderEvent, the processor's by its own timestamp — so a
 * refund never silently rewrites the day the original charge landed on.
 */
function refundVariances(
  ours: ReadonlyMap<string, number>,
  theirs: ReadonlyMap<string, number>,
): ReconciliationVariance[] {
  const out: ReconciliationVariance[] = [];
  for (const [date, ourCents] of ours) {
    const theirCents = theirs.get(date) ?? 0;
    if (ourCents === theirCents) continue;
    out.push({
      id: `refund-${date}`,
      date,
      kind: 'REFUND_MISMATCH',
      orderId: null,
      orderNumber: null,
      paymentId: null,
      intentId: null,
      ledgerCents: ourCents,
      processorCents: theirCents,
      varianceCents: theirCents - ourCents,
      detail: `We recorded ${formatUSD(ourCents)} of refunds on this day; the processor shows ${formatUSD(theirCents)}.`,
      action: 'Open the day’s refunds and check each one reached the processor.',
    });
  }
  for (const [date, theirCents] of theirs) {
    if (ours.has(date)) continue;
    out.push({
      id: `refund-${date}`,
      date,
      kind: 'REFUND_MISMATCH',
      orderId: null,
      orderNumber: null,
      paymentId: null,
      intentId: null,
      ledgerCents: 0,
      processorCents: theirCents,
      varianceCents: theirCents,
      detail: `The processor refunded ${formatUSD(theirCents)} on this day and we have no refund recorded against it.`,
      action: 'Record the refund so the order balance and the customer’s receipt agree.',
    });
  }
  return out;
}

/**
 * Fold both sides' movements into one row per calendar day across the whole
 * range — including the quiet days, so a gap in the table is never mistaken for
 * a missing day. `varianceCount` is filled in by the caller once the itemized
 * reasons are known.
 */
function buildDays(input: {
  start: Date;
  endExclusive: Date;
  processorUnavailable: boolean;
  ledgerCharges: readonly Movement[];
  ledgerRefundByDay: ReadonlyMap<string, number>;
  ledgerChargebacks: readonly Movement[];
  processorCaptures: readonly Movement[];
  processorRefundByDay: ReadonlyMap<string, number>;
  processorDisputes: readonly Movement[];
}): ReconciliationDay[] {
  const chargesByDay = sumByDay(input.ledgerCharges);
  const chargebacksByDay = sumByDay(input.ledgerChargebacks);
  const capturesByDay = sumByDay(input.processorCaptures);
  const disputesByDay = sumByDay(input.processorDisputes);

  const days: ReconciliationDay[] = [];
  for (
    let cursor = new Date(input.start);
    cursor < input.endExclusive;
    cursor = addDays(cursor, 1)
  ) {
    const date = isoDate(cursor);
    const ledgerChargedCents = chargesByDay.get(date) ?? 0;
    const ledgerRefundedCents = input.ledgerRefundByDay.get(date) ?? 0;
    const ledgerChargebackCents = chargebacksByDay.get(date) ?? 0;
    const processorCapturedCents = capturesByDay.get(date) ?? 0;
    const processorRefundedCents = input.processorRefundByDay.get(date) ?? 0;
    const processorDisputeCents = disputesByDay.get(date) ?? 0;

    const ledgerNetCents = ledgerChargedCents - ledgerRefundedCents - ledgerChargebackCents;
    const processorNetCents =
      processorCapturedCents - processorRefundedCents + processorDisputeCents;

    days.push({
      date,
      ledgerChargedCents,
      ledgerRefundedCents,
      ledgerChargebackCents,
      ledgerNetCents,
      processorCapturedCents,
      processorRefundedCents,
      processorDisputeCents,
      processorNetCents,
      varianceCents: input.processorUnavailable ? 0 : ledgerNetCents - processorNetCents,
      balanced: input.processorUnavailable || ledgerNetCents === processorNetCents,
      varianceCount: 0,
    });
  }
  return days;
}

/**
 * Whatever a day's itemized reasons do not account for. There is always exactly
 * one cause left when the items fall short — a charge and its processor record
 * landing on opposite sides of midnight — so name it rather than leaving an
 * unexplained number on an operator's screen.
 */
function timingVariances(
  days: readonly ReconciliationDay[],
  itemized: readonly ReconciliationVariance[],
): ReconciliationVariance[] {
  const out: ReconciliationVariance[] = [];
  for (const day of days) {
    const explained = itemized
      .filter((v) => v.date === day.date)
      .reduce((sum, v) => sum + v.varianceCents, 0);
    const residual = day.varianceCents - explained;
    if (residual === 0) continue;
    out.push({
      id: `timing-${day.date}`,
      date: day.date,
      kind: 'TIMING',
      orderId: null,
      orderNumber: null,
      paymentId: null,
      intentId: null,
      ledgerCents: null,
      processorCents: null,
      varianceCents: residual,
      detail: `${formatUSD(Math.abs(residual))} of this day's difference comes from a charge and its processor record falling on opposite sides of midnight.`,
      action: 'Check the neighbouring day — a timing difference cancels out across the two.',
    });
  }
  return out;
}

/** Sum dated movements into a per-day map. */
function sumByDay(movements: readonly Movement[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of movements) {
    out.set(m.date, (out.get(m.date) ?? 0) + m.cents);
  }
  return out;
}

/**
 * Replay dispute OrderEvents into the amount/intent/outcome this report needs.
 * Mirrors `foldDisputes` in the API's dispute service; see DisputeRecord above
 * for why it is not shared.
 */
function foldDisputeRecords(
  rows: ReadonlyArray<{
    order_id: string;
    type: string;
    created_at: Date;
    metadata: unknown;
    order: { order_number: string } | null;
  }>,
): DisputeRecord[] {
  const byId = new Map<string, DisputeRecord>();
  for (const row of rows) {
    const m = obj(row.metadata);
    const id = str(m.disputeId);
    if (!id) continue;

    if (row.type === 'DISPUTE_OPENED') {
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        intentId: str(m.intentId),
        paymentId: str(m.paymentId),
        orderId: row.order_id,
        orderNumber: row.order?.order_number ?? null,
        amountCents: int(m.amountCents),
        openedAt: row.created_at,
        resolvedAt: null,
        outcome: 'OPEN',
      });
      continue;
    }

    const dispute = byId.get(id);
    if (!dispute || dispute.outcome !== 'OPEN') continue;
    dispute.outcome = row.type === 'DISPUTE_WON' ? 'WON' : 'LOST';
    dispute.resolvedAt = row.created_at;
  }
  return [...byId.values()];
}

/** Roll non-card payments up by method — they can never appear on a card statement. */
function summarizeNonCard(
  payments: ReadonlyArray<{ method: string; status: string; amount_cents: number; refunded_cents: number }>,
): NonCardTotal[] {
  const buckets = new Map<string, NonCardTotal>();
  for (const p of payments) {
    if (p.method === 'CARD' || !isCaptured(p.status)) continue;
    const existing = buckets.get(p.method) ?? {
      method: p.method,
      label: NON_CARD_LABELS[p.method] ?? p.method,
      netCents: 0,
      count: 0,
    };
    existing.netCents += p.amount_cents - p.refunded_cents;
    existing.count += 1;
    buckets.set(p.method, existing);
  }
  return [...buckets.values()].sort((a, b) => b.netCents - a.netCents);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Reconciliation report (LOCAL-FIRST-BUILD §5): what we believe we collected
 * against what the processor says it holds, per day, with every difference
 * itemized rather than smoothed away.
 *
 * Gated behind `report:read` and tenant-scoped through RLS. Renders a denied
 * state instead of throwing, matching the other report routes.
 */
export default async function ReconciliationPage({ searchParams }: PageProps) {
  try {
    await requirePermission('report:read');
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return (
        <AdminShell>
          <PageHeader
            title="Reconciliation"
            description="What we collected against what the processor says."
          />
          <EmptyState
            icon={AlertTriangle}
            title="You don't have access to reports"
            description="Reporting requires the report:read permission. Ask an owner or admin to grant it."
          />
        </AdminShell>
      );
    }
    throw err;
  }

  const report = await buildReconciliation(single(searchParams?.from), single(searchParams?.to));

  return (
    <AdminShell>
      <PageHeader
        title="Reconciliation"
        description="Our books against the processor's, day by day. Every difference is named."
      />
      <div className="flex flex-col gap-6">
        <RangeFilter from={report.range.from} to={report.range.to} />
        <ReconciliationView report={report} />
      </div>
    </AdminShell>
  );
}

/**
 * Date-range filter as a plain GET form. No client bundle: this page is a
 * read-only report, and a form submit re-runs the tenant-scoped query the same
 * way a router push would.
 */
function RangeFilter({ from, to }: { from: string; to: string }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-body">
        From
        <input
          type="date"
          name="from"
          defaultValue={from}
          max={to}
          className="h-11 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-body">
        To
        <input
          type="date"
          name="to"
          defaultValue={to}
          min={from}
          className="h-11 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus"
        />
      </label>
      <Button type="submit" size="sm" variant="outline">
        Apply
      </Button>
    </form>
  );
}
