/**
 * Cancellation policy model + pure refund calculator.
 *
 * A cancellation policy is tiered on how far before the activity start the
 * cancellation happens: the earlier you cancel, the larger the refund. On top of
 * the tier percentage the operator may withhold a flat cancellation fee (once per
 * order, or once per guest). The result is always clamped into the amount actually
 * paid so a policy can never refund more than was collected or go negative.
 *
 * TIER SELECTION (the subtle part):
 *   tiers are thresholds, each `{ min_hours_before, refund_percent }`. The tier
 *   that applies is the one with the LARGEST `min_hours_before` that is still
 *   `<= hoursUntilStart`. In plain words: "you qualify for a tier once you are at
 *   least that many hours early; among the tiers you qualify for, take the most
 *   generous one you've cleared." A policy of 168->100, 24->50, 0->0 means:
 *     - cancel >= 168h out        -> 100%
 *     - cancel in [24h, 168h)     ->  50%
 *     - cancel in [0h, 24h)       ->   0%
 *     - cancel after start (<0h)  ->   0% (no tier qualifies; see below)
 *   If no tier qualifies (hoursUntilStart below every min_hours_before, e.g. the
 *   activity has already started and there is no 0h tier), the percent is 0.
 *
 * Everything here is pure and DB-free: pass the policy JSON (from
 * Operator/Activity.cancellation_policy), the start instant, and the amount paid.
 */
import { applyPercent } from './money.js';

/** One refund threshold. Cancel at least `min_hours_before` early -> `refund_percent`. */
export interface CancellationTier {
  /** Hours before start at/after which this tier is unlocked. */
  min_hours_before: number;
  /** Percent of amount paid refunded at this tier (0-100). */
  refund_percent: number;
}

/** Whether the flat cancellation fee is charged once per order or once per guest. */
export type FeeScope = 'order' | 'guest';

/** How the refund is disbursed. Informational for this calculator (not used in math). */
export type RefundMethod = 'card' | 'gift_card' | 'card_then_gift';

/**
 * A tenant default (Operator.cancellation_policy) or a per-activity override
 * (Activity.cancellation_policy). The JSON stored in the DB conforms to this.
 */
export interface CancellationPolicy {
  /** Refund thresholds. Order does not matter; the calculator sorts them. */
  tiers: CancellationTier[];
  /** Flat fee withheld from the refund, in integer cents. */
  cancellation_fee_cents: number;
  /** Charge the fee once per order, or once per guest. */
  fee_scope: FeeScope;
  /**
   * Cutoff (hours before start) before which a CUSTOMER may self-cancel. Staff
   * have no cutoff. Reported as `withinSelfCancelWindow`; does not affect refund math.
   */
  self_cancel_hours: number;
  /** How the refund is disbursed. */
  refund_method: RefundMethod;
}

export interface ComputeCancellationRefundInput {
  /** The policy to apply. null/undefined => no refund (0%, no fee, not self-cancelable). */
  policy: CancellationPolicy | null | undefined;
  /** When the activity starts. */
  startsAt: Date;
  /** The instant the cancellation is evaluated at (usually "now"). */
  now: Date;
  /** Integer cents the guest has actually paid (the refund can never exceed this). */
  amountPaidCents: number;
  /** Number of guests on the order; used only when fee_scope is 'guest'. Defaults to 1. */
  guestCount?: number;
}

export interface CancellationRefundResult {
  /** Cents to refund, clamped to [0, amountPaidCents]. */
  refundCents: number;
  /** Cents of cancellation fee actually withheld (clamped so it never exceeds the gross refund). */
  feeCents: number;
  /** The tier percent that was applied (0-100). */
  tierPercent: number;
  /**
   * True when `now` is before the self-cancel cutoff — i.e. a CUSTOMER is still
   * allowed to self-cancel. Staff cancellation ignores this flag.
   */
  withinSelfCancelWindow: boolean;
}

const MS_PER_HOUR = 1000 * 60 * 60;

/**
 * Select the applicable tier percent for `hoursUntilStart`.
 * Returns the refund_percent of the tier with the largest min_hours_before that
 * is still <= hoursUntilStart, or 0 if no tier qualifies.
 */
function selectTierPercent(tiers: readonly CancellationTier[], hoursUntilStart: number): number {
  let best: CancellationTier | null = null;
  for (const tier of tiers) {
    if (hoursUntilStart >= tier.min_hours_before) {
      if (best === null || tier.min_hours_before > best.min_hours_before) {
        best = tier;
      }
    }
  }
  return best ? best.refund_percent : 0;
}

/**
 * Pure cancellation refund calculator. See the module header for tier selection.
 *
 * Steps:
 *   1. hoursUntilStart = (startsAt - now) in hours (negative if already started).
 *   2. tierPercent = most-generous qualifying tier (0 if none / no policy).
 *   3. gross = applyPercent(amountPaid, tierPercent)  (exact half-cent math).
 *   4. fee = cancellation_fee_cents * (fee_scope === 'guest' ? guestCount : 1),
 *      clamped so it never exceeds the gross refund.
 *   5. refund = clamp(gross - fee, 0, amountPaid).
 */
export function computeCancellationRefund(
  input: ComputeCancellationRefundInput,
): CancellationRefundResult {
  const { policy, startsAt, now, amountPaidCents } = input;
  const guestCount = input.guestCount ?? 1;

  const hoursUntilStart = (startsAt.getTime() - now.getTime()) / MS_PER_HOUR;

  // No policy configured: nothing is refundable and self-cancel is not offered.
  if (!policy) {
    return { refundCents: 0, feeCents: 0, tierPercent: 0, withinSelfCancelWindow: false };
  }

  const withinSelfCancelWindow = hoursUntilStart >= policy.self_cancel_hours;

  const tierPercent = selectTierPercent(policy.tiers ?? [], hoursUntilStart);

  // Exact percentage of the amount paid.
  const gross = tierPercent <= 0 ? 0 : applyPercent(amountPaidCents, tierPercent);

  // Flat fee, scoped per-order or per-guest. Never withhold more than the gross refund.
  const feeUnits = policy.fee_scope === 'guest' ? Math.max(1, guestCount) : 1;
  const rawFee = Math.max(0, policy.cancellation_fee_cents | 0) * feeUnits;
  const feeCents = Math.min(rawFee, gross);

  // Clamp into [0, amountPaid].
  let refundCents = gross - feeCents;
  if (refundCents < 0) refundCents = 0;
  if (refundCents > amountPaidCents) refundCents = amountPaidCents;

  return { refundCents, feeCents, tierPercent, withinSelfCancelWindow };
}
