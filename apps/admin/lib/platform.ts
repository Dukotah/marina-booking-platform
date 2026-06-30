/**
 * Platform (super-admin) layer — the agency owner sitting ABOVE all tenants.
 *
 * Tenant pages talk to the DB through the RLS-scoped client and can only ever see
 * one operator. The platform layer is different: it manages every client, so it
 * uses `adminPrisma` (the owner/platform connection) and is gated strictly by
 * `isPlatformAdmin`. It also owns the "active client" cookie that lets a platform
 * admin drop into any client's admin (see lib/session.ts).
 */

import { cookies } from 'next/headers';
import { adminPrisma, createOperator, type NewOperatorInput } from '@marina/database';

export const ACTIVE_OPERATOR_COOKIE = 'active_operator';

/**
 * Is this identity allowed to run the platform? In production, gate strictly on
 * the PLATFORM_ADMIN_AUTH_IDS allowlist (Clerk user ids). In dev (Clerk off) the
 * `dev-owner` shim is always a platform admin so the cockpit is usable with no
 * accounts wired.
 */
export function isPlatformAdmin(authUserId: string | null | undefined): boolean {
  if (!authUserId) return false;
  if (process.env.REQUIRE_CLERK_AUTH !== 'true' && authUserId === 'dev-owner') {
    return true;
  }
  const allow = (process.env.PLATFORM_ADMIN_AUTH_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allow.includes(authUserId);
}

/** The operator id a platform admin has "opened", or null. */
export function getActiveOperatorOverride(): string | null {
  return cookies().get(ACTIVE_OPERATOR_COOKIE)?.value || null;
}

export interface OperatorListRow {
  id: string;
  slug: string;
  name: string;
  plan: string;
  isActive: boolean;
  brandColor: string;
  createdAt: Date;
  activities: number;
  orders: number;
  revenueCents: number;
}

/** All clients with quick counts + paid revenue, for the platform list. */
export async function listOperators(): Promise<OperatorListRow[]> {
  const [ops, revenue] = await Promise.all([
    adminPrisma.operator.findMany({
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        slug: true,
        name_external: true,
        plan: true,
        is_active: true,
        brand_color: true,
        created_at: true,
        _count: { select: { activities: true, orders: true } },
      },
    }),
    adminPrisma.order.groupBy({
      by: ['operator_id'],
      _sum: { amount_paid_cents: true },
    }),
  ]);
  const revByOp = new Map(revenue.map((r) => [r.operator_id, r._sum.amount_paid_cents ?? 0]));
  return ops.map((o) => ({
    id: o.id,
    slug: o.slug,
    name: o.name_external,
    plan: o.plan,
    isActive: o.is_active,
    brandColor: o.brand_color,
    createdAt: o.created_at,
    activities: o._count.activities,
    orders: o._count.orders,
    revenueCents: revByOp.get(o.id) ?? 0,
  }));
}

/** One operator's full record for the edit form. */
export async function getOperatorById(id: string) {
  return adminPrisma.operator.findUnique({ where: { id } });
}

export interface UpdateOperatorPatch {
  name_external?: string;
  name_internal?: string;
  brand_color?: string;
  website?: string | null;
  phone?: string | null;
  timezone?: string;
  legal_adult_age?: number;
  plan?: string;
  is_active?: boolean;
  custom_domain?: string | null;
}

/** Update a client's account (platform-level; cross-tenant via adminPrisma). */
export async function updateOperatorRecord(id: string, patch: UpdateOperatorPatch) {
  return adminPrisma.operator.update({ where: { id }, data: patch });
}

/** Provision a brand-new client. Thin pass-through to the shared engine. */
export async function provisionClient(input: NewOperatorInput) {
  return createOperator(input);
}

/** Raised when a non-platform identity attempts a platform operation. */
export class PlatformAccessError extends Error {
  constructor() {
    super('Platform access required.');
    this.name = 'PlatformAccessError';
  }
}

/** Throw if the current identity is not a platform admin. */
export function assertPlatformAdmin(authUserId: string | null | undefined): void {
  if (!isPlatformAdmin(authUserId)) {
    throw new PlatformAccessError();
  }
}
