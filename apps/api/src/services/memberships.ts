/**
 * Memberships / season passes (Upmarket §1 #6-A).
 *
 * An operator defines Memberships (season pass, N-launch punch card, or a plain
 * member-rate tier). A Customer holds one via CustomerMembership, which tracks the
 * validity window and — for punch cards — remaining uses. At booking time the
 * booking service asks this module for the customer's BEST active member discount
 * and applies it to each unit's price via @marina/core `applyMemberPrice`; a
 * punch-card booking then decrements the holding.
 *
 * Everything is tenant-scoped: the booking service already runs inside a
 * `withTenant` transaction, so these helpers take the transaction client and never
 * open their own connection (keeping the whole booking atomic).
 */
import { Prisma, forOperator, withTenant } from '@marina/database';
import type { MemberDiscount } from '@marina/core';

/** A typed, user-facing failure the route handlers map to a clean HTTP status. */
export class MembershipError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'MembershipError';
    this.code = code;
    this.status = status;
  }
}

/** The active holding chosen to price a booking (and, if a punch card, to decrement). */
export interface ActiveMemberPricing {
  customerMembershipId: string;
  membershipId: string;
  membershipName: string;
  kind: 'SEASON_PASS' | 'PUNCH_CARD' | 'MEMBER_RATE';
  discount: MemberDiscount;
  /** null for unlimited passes / member-rate tiers; a number for punch cards. */
  remainingUses: number | null;
}

/** Is a CustomerMembership usable right now (status + validity window + uses left)? */
function isHoldingUsable(row: {
  status: string;
  expires_at: Date | null;
  starts_at: Date;
  remaining_uses: number | null;
}): boolean {
  if (row.status !== 'ACTIVE') return false;
  const now = Date.now();
  if (row.starts_at.getTime() > now) return false;
  if (row.expires_at && row.expires_at.getTime() < now) return false;
  if (row.remaining_uses != null && row.remaining_uses <= 0) return false;
  return true;
}

/**
 * The best active member discount for a customer, or null when they hold none.
 * "Best" = the largest effective discount on the given base price (so a customer
 * holding both a 10%-off pass and a $5-off card gets whichever saves more). Reads
 * only — safe to call with either the tenant tx client or a fresh forOperator db.
 *
 * @param db a Prisma client already scoped to the operator (tx or forOperator)
 */
export async function bestActiveMemberPricing(
  db: Prisma.TransactionClient,
  params: { customerId: string; basePriceCents: number },
): Promise<ActiveMemberPricing | null> {
  const holdings = await db.customerMembership.findMany({
    where: { customer_id: params.customerId, status: 'ACTIVE' },
    select: {
      id: true,
      membership_id: true,
      status: true,
      starts_at: true,
      expires_at: true,
      remaining_uses: true,
      membership: {
        select: {
          name: true,
          kind: true,
          is_active: true,
          discount_type: true,
          discount_value: true,
        },
      },
    },
  });

  let best: ActiveMemberPricing | null = null;
  let bestOff = 0;
  for (const h of holdings) {
    if (!h.membership.is_active) continue;
    if (!isHoldingUsable(h)) continue;
    const discount: MemberDiscount = {
      discountType: h.membership.discount_type,
      discountValue: h.membership.discount_value,
    };
    // Effective cents off this base price (percent resolved against the base).
    const off =
      discount.discountType === 'PERCENT'
        ? Math.round((Math.max(0, params.basePriceCents) * discount.discountValue) / 100)
        : discount.discountValue;
    if (off > bestOff) {
      bestOff = off;
      best = {
        customerMembershipId: h.id,
        membershipId: h.membership_id,
        membershipName: h.membership.name,
        kind: h.membership.kind,
        discount,
        remainingUses: h.remaining_uses,
      };
    }
  }
  return best;
}

/**
 * Consume `count` uses off a punch-card holding, flipping it to DEPLETED when it
 * hits zero. No-op for holdings with null remaining_uses (unlimited passes). Runs
 * on the passed transaction client so it commits with the booking. Never throws on
 * an unlimited holding; guards remaining_uses at a floor of 0.
 */
export async function consumeMembershipUses(
  db: Prisma.TransactionClient,
  customerMembershipId: string,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  const holding = await db.customerMembership.findUnique({
    where: { id: customerMembershipId },
    select: { remaining_uses: true, status: true },
  });
  if (!holding || holding.remaining_uses == null) return; // unlimited / gone: nothing to decrement
  const next = Math.max(0, holding.remaining_uses - count);
  await db.customerMembership.update({
    where: { id: customerMembershipId },
    data: {
      remaining_uses: next,
      status: next <= 0 ? 'DEPLETED' : holding.status,
    },
  });
}

// ---------------------------------------------------------------------------
// Issue (staff / checkout) — grant a membership to a customer
// ---------------------------------------------------------------------------

export interface IssueMembershipInput {
  membershipId: string;
  customerId: string;
  actor?: string;
}

/**
 * Grant a customer a membership: creates the CustomerMembership holding, seeding
 * remaining_uses from the Membership's total_uses (for punch cards) and the expiry
 * from its duration_days. Runs in a tenant transaction. Mirrors the resilient,
 * never-surprising pattern of the gift-card issue path.
 */
export async function issueCustomerMembership(
  operatorId: string,
  input: IssueMembershipInput,
) {
  return withTenant(operatorId, async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { id: input.membershipId },
      select: { id: true, is_active: true, kind: true, total_uses: true, duration_days: true },
    });
    if (!membership) throw new MembershipError('NOT_FOUND', 'Membership not found', 404);
    if (!membership.is_active) throw new MembershipError('INACTIVE', 'This membership is not sold');

    const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw new MembershipError('CUSTOMER_NOT_FOUND', 'Customer not found', 404);

    const expiresAt =
      membership.duration_days != null
        ? new Date(Date.now() + membership.duration_days * 86_400_000)
        : null;

    return tx.customerMembership.create({
      data: {
        operator_id: operatorId,
        membership_id: membership.id,
        customer_id: input.customerId,
        status: 'ACTIVE',
        remaining_uses: membership.kind === 'PUNCH_CARD' ? membership.total_uses ?? null : null,
        expires_at: expiresAt,
      },
    });
  });
}

/** List an operator's membership products (staff catalog). */
export async function listMemberships(operatorId: string) {
  const db = forOperator(operatorId);
  return db.membership.findMany({ orderBy: { created_at: 'desc' } });
}
