/**
 * Manager-approval workflow (Singenuity §2).
 *
 * An operator can require a manager-level sign-off (`order:approve`) on money
 * movements:
 *   - `approval_threshold_cents` — any payment OR refund whose amount is at/above
 *     this value requires approval (null/0 = no amount gate);
 *   - `refund_requires_approval` — when true, EVERY refund requires approval
 *     regardless of amount.
 *
 * This module is pure decision logic + a small audit helper so it is trivially
 * unit-testable without a DB or provider. The routes call `evaluateApproval` to
 * decide, then (on approval) `recordApprovalEvent` to leave an OrderEvent audit.
 */

import type { AuthContext } from '@marina/auth';
import { hasPermission } from '@marina/auth';
import { createId } from '@marina/core';
import type { Prisma, TenantClient } from '@marina/database';

export type ApprovalAction = 'payment' | 'refund' | 'discount';

/** The operator-level knobs that drive the approval gate. */
export interface ApprovalPolicy {
  approvalThresholdCents: number | null;
  refundRequiresApproval: boolean;
}

export interface ApprovalDecision {
  /** True when a manager-level sign-off is required for this action/amount. */
  required: boolean;
  /** Human-readable reason (for audit + error messages). */
  reason: string | null;
  /** True when approval is required AND the caller may not self-approve. */
  blocked: boolean;
}

/**
 * Decide whether an action needs manager approval and whether the current caller
 * clears it. A caller who holds `order:approve` self-approves (required stays true
 * for the audit trail, but `blocked` is false). A caller without it is blocked
 * whenever approval is required.
 *
 * Rules:
 *  - refund + refundRequiresApproval  → required
 *  - amount >= approvalThresholdCents (threshold > 0) → required
 *  - otherwise not required.
 */
export function evaluateApproval(args: {
  action: ApprovalAction;
  amountCents: number;
  policy: ApprovalPolicy;
  auth: AuthContext;
}): ApprovalDecision {
  const { action, amountCents, policy, auth } = args;

  let required = false;
  let reason: string | null = null;

  if (action === 'refund' && policy.refundRequiresApproval) {
    required = true;
    reason = 'Refunds require manager approval';
  }

  const threshold = policy.approvalThresholdCents ?? 0;
  if (threshold > 0 && amountCents >= threshold) {
    required = true;
    const label =
      action === 'refund' ? 'Refund' : action === 'discount' ? 'Discount/comp' : 'Charge';
    reason = `${label} of ${(amountCents / 100).toFixed(2)} meets the ${(threshold / 100).toFixed(2)} approval threshold`;
  }

  const canApprove = hasPermission(auth, 'order:approve');
  return { required, reason, blocked: required && !canApprove };
}

/** Load an operator's approval policy through the tenant-scoped client. */
export async function loadApprovalPolicy(
  db: TenantClient,
  operatorId: string,
): Promise<ApprovalPolicy> {
  const op = await db.operator.findUnique({
    where: { id: operatorId },
    select: { approval_threshold_cents: true, refund_requires_approval: true },
  });
  return {
    approvalThresholdCents: op?.approval_threshold_cents ?? null,
    refundRequiresApproval: op?.refund_requires_approval ?? false,
  };
}

/**
 * Write an OrderEvent recording that a manager approved (or self-approved) a money
 * movement. Call inside the same transaction that records the payment/refund so the
 * audit and the action commit together.
 */
export async function recordApprovalEvent(
  tx: Prisma.TransactionClient,
  args: {
    operatorId: string;
    orderId: string;
    action: ApprovalAction;
    amountCents: number;
    actor: string;
    reason: string | null;
  },
): Promise<void> {
  await tx.orderEvent.create({
    data: {
      id: createId(),
      operator_id: args.operatorId,
      order_id: args.orderId,
      type: 'APPROVAL',
      description: `${
        args.action === 'refund' ? 'Refund' : args.action === 'discount' ? 'Discount/comp' : 'Payment'
      } approved by manager (${(args.amountCents / 100).toFixed(2)} USD)${args.reason ? ` — ${args.reason}` : ''}`,
      actor: args.actor,
      metadata: {
        action: args.action,
        amountCents: args.amountCents,
        reason: args.reason,
      },
    },
  });
}
