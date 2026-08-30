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
import type { OnboardingStage } from '@marina/database';
import { loadReadiness, STAGE_ORDER, type ClientReadiness } from './readiness';

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

/** The most recent open blocker note somebody at the platform wrote on a client. */
export interface BlockerNote {
  author: string;
  body: string;
  createdAt: Date;
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
  /**
   * The onboarding stage. Falls back to the stage the client's own data implies
   * when no OperatorOnboarding row exists — a client nobody has filed paperwork
   * for still belongs in the right column, not lumped in with the brand new ones.
   */
  stage: OnboardingStage;
  /** True when `stage` was inferred rather than recorded, so the UI can say so. */
  stageIsDerived: boolean;
  /** Who at the platform owns getting this one live. */
  onboardingOwner: string | null;
  targetLiveOn: Date | null;
  wentLiveOn: Date | null;
  /** Derived, never stored — see lib/readiness.ts. */
  readiness: ClientReadiness;
  /** A human said this is what the client is stuck on; it outranks any guess. */
  blockerNote: BlockerNote | null;
}

/**
 * All clients with quick counts, paid revenue, onboarding stage and live
 * readiness, for the platform list.
 *
 * The cost of this is a fixed set of aggregates — it does NOT grow with the number
 * of clients. Anything added here must keep that property: the moment the list
 * costs one query per client, it stops being the screen the owner opens first.
 */
export async function listOperators(): Promise<OperatorListRow[]> {
  const [ops, blockerNotes] = await Promise.all([
    adminPrisma.operator.findMany({
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        slug: true,
        name_external: true,
        plan: true,
        is_active: true,
        brand_color: true,
        logo_dark_url: true,
        logo_light_url: true,
        created_at: true,
        _count: { select: { activities: true, orders: true } },
        onboarding: {
          select: { stage: true, owner: true, target_live_on: true, went_live_on: true },
        },
      },
    }),
    adminPrisma.operatorNote.findMany({
      where: { is_blocker: true },
      orderBy: { created_at: 'desc' },
      select: { operator_id: true, author: true, body: true, created_at: true },
    }),
  ]);

  const readiness = await loadReadiness(
    ops.map((o) => ({
      id: o.id,
      brandColor: o.brand_color,
      logoDarkUrl: o.logo_dark_url,
      logoLightUrl: o.logo_light_url,
    })),
  );

  // Notes come back newest-first, so the first one seen per client is the current
  // blocker; older ones are history and belong on the client's own page.
  const latestBlocker = new Map<string, BlockerNote>();
  for (const note of blockerNotes) {
    if (latestBlocker.has(note.operator_id)) continue;
    latestBlocker.set(note.operator_id, {
      author: note.author,
      body: note.body,
      createdAt: note.created_at,
    });
  }

  return ops.flatMap((o) => {
    // loadReadiness is fed exactly these ids, so a miss is impossible; skipping
    // rather than asserting means a future refactor degrades to a shorter list
    // instead of throwing on the owner's home screen.
    const health = readiness.get(o.id);
    if (!health) return [];
    return [{
      id: o.id,
      slug: o.slug,
      name: o.name_external,
      plan: o.plan,
      isActive: o.is_active,
      brandColor: o.brand_color,
      createdAt: o.created_at,
      activities: o._count.activities,
      orders: o._count.orders,
      revenueCents: health.paidRevenueCents,
      stage: o.onboarding?.stage ?? health.derivedStage,
      stageIsDerived: !o.onboarding,
      onboardingOwner: o.onboarding?.owner ?? null,
      targetLiveOn: o.onboarding?.target_live_on ?? null,
      wentLiveOn: o.onboarding?.went_live_on ?? null,
      readiness: health,
      blockerNote: latestBlocker.get(o.id) ?? null,
    }];
  });
}

// ---------------------------------------------------------------------------
// Ordering the list
// ---------------------------------------------------------------------------

export type ClientSortKey = 'attention' | 'name' | 'stage' | 'ready' | 'activities' | 'orders' | 'revenue';
export type SortDirection = 'asc' | 'desc';

/** Default direction per column: the one a person means on the first click. */
export const DEFAULT_SORT_DIRECTION: Record<ClientSortKey, SortDirection> = {
  attention: 'desc',
  name: 'asc',
  stage: 'asc',
  ready: 'asc',
  activities: 'desc',
  orders: 'desc',
  revenue: 'desc',
};

const SORT_KEYS = Object.keys(DEFAULT_SORT_DIRECTION) as ClientSortKey[];

/** Narrow an untrusted query param to a sort key, falling back to the default. */
export function parseSortKey(value: unknown): ClientSortKey {
  return SORT_KEYS.includes(value as ClientSortKey) ? (value as ClientSortKey) : 'attention';
}

export function parseSortDirection(value: unknown, key: ClientSortKey): SortDirection {
  if (value === 'asc' || value === 'desc') return value;
  return DEFAULT_SORT_DIRECTION[key];
}

/**
 * How badly a client needs looking at. Blockers dominate warnings, warnings
 * dominate the raw percentage, and a suspended account beats everything — the
 * whole point of the default order is that a healthy client never needs to be
 * scrolled past to reach a stuck one.
 */
function attentionScore(row: OperatorListRow): number {
  const suspended = row.isActive ? 0 : 100_000;
  const humanBlocker = row.blockerNote ? 10_000 : 0;
  return (
    suspended +
    humanBlocker +
    row.readiness.blockedCount * 1_000 +
    row.readiness.warnCount * 10 +
    (100 - row.readiness.percent)
  );
}

/** Sort a client list. Pure and total — ties fall back to name for a stable order. */
export function sortClients(
  rows: readonly OperatorListRow[],
  key: ClientSortKey,
  direction: SortDirection,
): OperatorListRow[] {
  const compare = (a: OperatorListRow, b: OperatorListRow): number => {
    switch (key) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'stage':
        return STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
      case 'ready':
        return a.readiness.percent - b.readiness.percent;
      case 'activities':
        return a.activities - b.activities;
      case 'orders':
        return a.orders - b.orders;
      case 'revenue':
        return a.revenueCents - b.revenueCents;
      case 'attention':
      default:
        return attentionScore(a) - attentionScore(b);
    }
  };
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const primary = compare(a, b) * sign;
    return primary !== 0 ? primary : a.name.localeCompare(b.name);
  });
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
