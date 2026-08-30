/**
 * Reads for the per-client onboarding cockpit.
 *
 * PLATFORM DATA WARNING: `OperatorOnboarding` and `OperatorNote` sit deliberately
 * OUTSIDE tenant RLS — they are the agency's private record of how a client's rollout
 * is going, and an operator must never see them. They are therefore only ever reached
 * through `adminPrisma`, from the /platform tree, which is gated by `isPlatformAdmin`
 * in platform/layout.tsx and again in every mutation in platform/actions.ts.
 *
 * The vital signs below read tenant tables through `adminPrisma` too. That is correct
 * here and only here: the platform admin is legitimately above every tenant, and a
 * per-tenant client cannot answer "how is this client doing" for a client that is not
 * the current one.
 */

import { adminPrisma } from '@marina/database';
import type { OnboardingStageValue } from './onboarding-stages';

export interface CockpitOnboarding {
  stage: OnboardingStageValue;
  owner: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  targetLiveOn: Date | null;
  wentLiveOn: Date | null;
  /** False when nobody has filled this in yet — the form renders empty, not wrong. */
  exists: boolean;
}

export interface CockpitNote {
  id: string;
  author: string;
  body: string;
  isBlocker: boolean;
  createdAt: Date;
}

export interface CockpitVitals {
  activeActivities: number;
  totalActivities: number;
  /** Seats booked on a departure that has not happened yet. */
  upcomingSeats: number;
  /** The next departure that has seats on it, if any. */
  nextDepartureAt: Date | null;
  revenueCents: number;
  revenueLast30Cents: number;
  ordersAllTime: number;
  orders30d: number;
  lastOrderAt: Date | null;
  /**
   * Whole days since the last order was taken; null when they have never taken one.
   * Never negative: a post-dated order (a staff booking entered ahead of the season)
   * means they are demonstrably active, so it counts as today rather than as a
   * negative that would quietly break the quiet-client comparison.
   */
  daysSinceLastOrder: number | null;
  customerCount: number;
}

/** How much of the log we load. Deep history belongs in a report, not this screen. */
export const NOTE_HISTORY_LIMIT = 50;

export interface ClientCockpit {
  onboarding: CockpitOnboarding;
  notes: CockpitNote[];
  vitals: CockpitVitals;
}

/** Everything the cockpit renders, in one round trip's worth of parallel queries. */
export async function getClientCockpit(operatorId: string): Promise<ClientCockpit> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    onboarding,
    notes,
    activeActivities,
    totalActivities,
    upcoming,
    nextDeparture,
    paidAllTime,
    paid30d,
    orders30d,
    lastOrder,
    customerCount,
  ] = await Promise.all([
    adminPrisma.operatorOnboarding.findUnique({ where: { operator_id: operatorId } }),
    adminPrisma.operatorNote.findMany({
      where: { operator_id: operatorId },
      orderBy: { created_at: 'desc' },
      take: NOTE_HISTORY_LIMIT,
    }),
    adminPrisma.activity.count({ where: { operator_id: operatorId, status: 'ACTIVE' } }),
    adminPrisma.activity.count({ where: { operator_id: operatorId } }),
    adminPrisma.orderItem.aggregate({
      where: {
        operator_id: operatorId,
        status: 'UPCOMING',
        timeslot: { datetime: { gte: now } },
      },
      _sum: { quantity: true },
    }),
    adminPrisma.timeslot.findFirst({
      where: {
        operator_id: operatorId,
        datetime: { gte: now },
        capacity_booked: { gt: 0 },
      },
      orderBy: { datetime: 'asc' },
      select: { datetime: true },
    }),
    adminPrisma.order.aggregate({
      where: { operator_id: operatorId },
      _sum: { amount_paid_cents: true },
      _count: { _all: true },
    }),
    adminPrisma.order.aggregate({
      where: { operator_id: operatorId, created_at: { gte: thirtyDaysAgo } },
      _sum: { amount_paid_cents: true },
    }),
    adminPrisma.order.count({
      where: { operator_id: operatorId, created_at: { gte: thirtyDaysAgo } },
    }),
    adminPrisma.order.findFirst({
      where: { operator_id: operatorId },
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    }),
    adminPrisma.customer.count({ where: { operator_id: operatorId } }),
  ]);

  const lastOrderAt = lastOrder?.created_at ?? null;

  return {
    onboarding: {
      stage: (onboarding?.stage as OnboardingStageValue | undefined) ?? 'PROVISIONED',
      owner: onboarding?.owner ?? '',
      contactName: onboarding?.contact_name ?? '',
      contactEmail: onboarding?.contact_email ?? '',
      contactPhone: onboarding?.contact_phone ?? '',
      targetLiveOn: onboarding?.target_live_on ?? null,
      wentLiveOn: onboarding?.went_live_on ?? null,
      exists: Boolean(onboarding),
    },
    notes: notes.map((n) => ({
      id: n.id,
      author: n.author,
      body: n.body,
      isBlocker: n.is_blocker,
      createdAt: n.created_at,
    })),
    vitals: {
      activeActivities,
      totalActivities,
      upcomingSeats: upcoming._sum.quantity ?? 0,
      nextDepartureAt: nextDeparture?.datetime ?? null,
      revenueCents: paidAllTime._sum.amount_paid_cents ?? 0,
      revenueLast30Cents: paid30d._sum.amount_paid_cents ?? 0,
      ordersAllTime: paidAllTime._count._all,
      orders30d,
      lastOrderAt,
      daysSinceLastOrder: lastOrderAt ? Math.max(0, daysBetween(lastOrderAt, now)) : null,
      customerCount,
    },
  };
}

/** Whole days elapsed, floored — "23 days since a booking" reads better than 23.4. */
function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}
