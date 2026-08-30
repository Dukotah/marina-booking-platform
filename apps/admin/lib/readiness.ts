/**
 * Client readiness — the answer to "which of my clients is stuck, and on what?"
 *
 * Once a client is provisioned the platform list turns them into a row: plan,
 * status, three counts. That tells the owner nothing about whether the client can
 * actually take a booking on Saturday. This module works that out from the client's
 * REAL data and says it in a sentence.
 *
 * Two rules shaped everything here.
 *
 * 1. Readiness is DERIVED, never stored. Whether a client has activities, prices,
 *    a schedule or a waiver is a fact about their rows; a stored copy is a cache of
 *    a fact that changes underneath it, and a stale "ready" is worse than no answer
 *    at all. So it is computed on read, every time.
 *
 * 2. It is ONE pass for ALL clients. Ten aggregate queries whatever the client
 *    count — never a query per client. Twelve clients must not mean sixty round
 *    trips, because the moment this page is slow the owner stops opening it.
 *
 * This is PLATFORM data by nature (it spans tenants), so it runs on `adminPrisma`
 * and must only ever be reached from behind the `isPlatformAdmin` gate. Nothing in
 * here may be rendered inside an operator's own admin.
 */

import { differenceInCalendarDays } from 'date-fns';
import { adminPrisma } from '@marina/database';
import type { ActivityCategory, OnboardingStage } from '@marina/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = 'OK' | 'WARN' | 'BLOCKED' | 'NOT_APPLICABLE';

/** Whose move it is. The owner's real question is "am I waiting, or are they?" */
export type Court = 'US' | 'THE_CLIENT';

export type ReadinessCheckId =
  | 'owner_staff'
  | 'location'
  | 'catalog'
  | 'rates'
  | 'schedule'
  | 'waiver'
  | 'fees'
  | 'branding'
  | 'fleet'
  | 'first_booking';

export interface ReadinessCheck {
  id: ReadinessCheckId;
  /** Two words at most — this has to fit in a table cell. */
  label: string;
  status: CheckStatus;
  /** Plain sentence: what this means, and what to do about it. */
  detail: string;
  court: Court;
  /**
   * Path INSIDE the client's own admin that fixes it. The platform admin reaches
   * it by "opening" the client (the active-operator cookie) and landing there, so
   * these are app-relative paths, never absolute URLs.
   */
  fixHref: string;
}

export interface ClientReadiness {
  operatorId: string;
  /** In priority order: the first unmet one is the thing to chase. */
  checks: ReadinessCheck[];
  /** 0-100 across applicable checks. WARN counts half — see scoreChecks. */
  percent: number;
  blockedCount: number;
  warnCount: number;
  /** Applicable checks that are fully OK. */
  okCount: number;
  applicableCount: number;
  /** The single most important unmet thing, or null when everything is green. */
  topBlocker: ReadinessCheck | null;
  /**
   * Days of bookable schedule left on the activity that runs out FIRST. null when
   * the client has no active activities to schedule.
   */
  scheduleHorizonDays: number | null;
  /** What the data says the stage is, used when no OperatorOnboarding row exists. */
  derivedStage: OnboardingStage;
  /**
   * These two ride along because the first-booking check already has to aggregate
   * orders. Returning them means the client list does not run the same groupBy a
   * second time just to print a revenue column.
   */
  bookingCount: number;
  paidRevenueCents: number;
}

/** The operator facts readiness needs. The caller already selected these. */
export interface ReadinessOperatorInput {
  id: string;
  brandColor: string;
  logoDarkUrl: string | null;
  logoLightUrl: string | null;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Schema + provisioning default. Unchanged means nobody has done branding yet. */
export const DEFAULT_BRAND_COLOR = '#0ea5e9';

/**
 * A schedule that ends inside two weeks is the quiet killer: nothing errors, the
 * activity simply stops appearing and the client thinks demand dried up. Two weeks
 * is enough runway to notice, call them, and extend before a guest is turned away.
 */
export const SCHEDULE_WARN_DAYS = 14;

/**
 * Categories whose capacity is backed by physical kit that activities share — one
 * pontoon boat can be sold as a half-day rental and as a sunset tour, and only the
 * shared-resource engine stops it being sold twice. A class or an event has no
 * fleet, so the check does not apply to them.
 */
const RESOURCE_BACKED: ReadonlySet<ActivityCategory> = new Set<ActivityCategory>([
  'BOAT',
  'WATERCRAFT',
  'EQUIPMENT',
  'PATIO',
  'LODGING',
]);

/** Slot states a guest can actually buy. FULL and CANCELLED are not inventory. */
const BOOKABLE_SLOT_STATUSES = ['AVAILABLE', 'FILLING_UP'] as const;

// ---------------------------------------------------------------------------
// Scoring (pure — no DB, no clock)
// ---------------------------------------------------------------------------

/**
 * A percentage over the checks that apply to this client.
 *
 * WARN counts half rather than zero on purpose. A client with a short schedule and
 * no logo is genuinely closer to live than one with no prices, and flattening both
 * to "not OK" would sort them together — which is the exact failure this page
 * exists to fix. NOT_APPLICABLE is excluded entirely: a kayak school is not 10%
 * less ready because it owns no boats.
 */
export function scoreChecks(checks: readonly ReadinessCheck[]): {
  percent: number;
  blockedCount: number;
  warnCount: number;
  okCount: number;
  applicableCount: number;
} {
  let earned = 0;
  let applicableCount = 0;
  let blockedCount = 0;
  let warnCount = 0;
  let okCount = 0;

  for (const check of checks) {
    if (check.status === 'NOT_APPLICABLE') continue;
    applicableCount += 1;
    if (check.status === 'OK') {
      earned += 1;
      okCount += 1;
    } else if (check.status === 'WARN') {
      earned += 0.5;
      warnCount += 1;
    } else {
      blockedCount += 1;
    }
  }

  return {
    percent: applicableCount === 0 ? 100 : Math.round((earned / applicableCount) * 100),
    blockedCount,
    warnCount,
    okCount,
    applicableCount,
  };
}

/** The first unmet check in priority order: BLOCKED beats WARN, order breaks ties. */
export function pickTopBlocker(checks: readonly ReadinessCheck[]): ReadinessCheck | null {
  return (
    checks.find((c) => c.status === 'BLOCKED') ?? checks.find((c) => c.status === 'WARN') ?? null
  );
}

/**
 * What the client's data says their stage is. Used only when no OperatorOnboarding
 * row exists yet — a client nobody has filed paperwork for should still show up in
 * the right column instead of defaulting everyone to PROVISIONED.
 *
 * It deliberately never guesses CHURNED or LEAD: both are human facts about a
 * relationship, and inventing them from row counts would put words in the owner's
 * mouth.
 */
export function deriveStage(input: {
  blockedCount: number;
  hasBooking: boolean;
  hasActiveActivity: boolean;
}): OnboardingStage {
  if (input.blockedCount === 0 && input.hasBooking) return 'LIVE';
  if (input.blockedCount === 0) return 'TESTING';
  if (input.hasActiveActivity) return 'CONFIGURING';
  return 'PROVISIONED';
}

/** How a stage reads in a table cell. */
export const STAGE_LABEL: Record<OnboardingStage, string> = {
  LEAD: 'Lead',
  PROVISIONED: 'Provisioned',
  CONFIGURING: 'Configuring',
  TESTING: 'Testing',
  LIVE: 'Live',
  CHURNED: 'Churned',
};

/** Earliest-first, so a stage can be sorted as progress rather than alphabetically. */
export const STAGE_ORDER: Record<OnboardingStage, number> = {
  LEAD: 0,
  PROVISIONED: 1,
  CONFIGURING: 2,
  TESTING: 3,
  LIVE: 4,
  CHURNED: 5,
};

/** "Us" / "The client" — who has to move next. */
export function courtLabel(court: Court): string {
  return court === 'US' ? 'Us' : 'The client';
}

// ---------------------------------------------------------------------------
// The single pass
// ---------------------------------------------------------------------------

interface ActivityFact {
  id: string;
  operatorId: string;
  name: string;
  category: ActivityCategory;
}

/**
 * Readiness for every operator passed in, computed in a fixed number of queries.
 *
 * `now` is injectable so the schedule-horizon check is testable and so a sandbox
 * clock jump produces the horizon the operator would actually see.
 */
export async function loadReadiness(
  operators: readonly ReadinessOperatorInput[],
  now: Date = new Date(),
): Promise<Map<string, ClientReadiness>> {
  const result = new Map<string, ClientReadiness>();
  if (operators.length === 0) return result;

  const operatorIds = operators.map((o) => o.id);
  const scope = { operator_id: { in: operatorIds } };

  // Ten aggregates, all in parallel, all independent of client count. Rates and
  // timeslots group by activity because "every active activity has a price / has a
  // schedule" is a per-activity fact — rolling it up per operator would let one
  // well-configured activity hide nine broken ones.
  const [
    locationGroups,
    activeActivities,
    activeActivityCounts,
    rateGroups,
    slotGroups,
    waiverGroups,
    feeGroups,
    ownerGroups,
    orderGroups,
    resources,
  ] = await Promise.all([
    adminPrisma.location.groupBy({ by: ['operator_id'], where: scope, _count: { _all: true } }),
    adminPrisma.activity.findMany({
      where: { ...scope, status: 'ACTIVE' },
      select: { id: true, operator_id: true, name_external: true, category: true },
      orderBy: { sort_index: 'asc' },
    }),
    adminPrisma.activity.groupBy({ by: ['operator_id'], where: scope, _count: { _all: true } }),
    adminPrisma.rate.groupBy({
      by: ['activity_id'],
      where: { ...scope, is_active: true },
      _count: { _all: true },
    }),
    adminPrisma.timeslot.groupBy({
      by: ['activity_id'],
      where: { ...scope, datetime: { gte: now }, status: { in: [...BOOKABLE_SLOT_STATUSES] } },
      _max: { datetime: true },
      _count: { _all: true },
    }),
    adminPrisma.waiver.groupBy({
      by: ['operator_id'],
      where: { ...scope, is_active: true },
      _count: { _all: true },
    }),
    adminPrisma.fee.groupBy({
      by: ['operator_id'],
      where: scope,
      _count: { _all: true },
      _sum: { value: true },
    }),
    adminPrisma.staffMember.groupBy({
      by: ['operator_id'],
      where: { ...scope, role: 'OWNER', is_active: true },
      _count: { _all: true },
    }),
    adminPrisma.order.groupBy({
      by: ['operator_id', 'status'],
      where: scope,
      _count: { _all: true },
      _sum: { amount_paid_cents: true },
    }),
    adminPrisma.resource.findMany({
      where: { ...scope, is_active: true },
      select: { operator_id: true, _count: { select: { activities: true } } },
    }),
  ]);

  // --- fold the aggregates into per-operator lookups -----------------------
  const locationCount = countByOperator(locationGroups);
  const totalActivityCount = countByOperator(activeActivityCounts);
  const waiverCount = countByOperator(waiverGroups);
  const ownerCount = countByOperator(ownerGroups);

  const activitiesByOperator = new Map<string, ActivityFact[]>();
  for (const a of activeActivities) {
    const list = activitiesByOperator.get(a.operator_id) ?? [];
    list.push({
      id: a.id,
      operatorId: a.operator_id,
      name: a.name_external,
      category: a.category,
    });
    activitiesByOperator.set(a.operator_id, list);
  }

  const ratedActivityIds = new Set(rateGroups.filter((r) => r._count._all > 0).map((r) => r.activity_id));

  const slotHorizonByActivity = new Map<string, Date>();
  for (const s of slotGroups) {
    if (s._count._all > 0 && s._max.datetime) slotHorizonByActivity.set(s.activity_id, s._max.datetime);
  }

  const feeFacts = new Map<string, { count: number; total: number }>();
  for (const f of feeGroups) {
    feeFacts.set(f.operator_id, { count: f._count._all, total: f._sum.value ?? 0 });
  }

  const orderFacts = new Map<string, { booked: number; paidCents: number }>();
  for (const o of orderGroups) {
    const prev = orderFacts.get(o.operator_id) ?? { booked: 0, paidCents: 0 };
    // Revenue is every cent collected, including on orders later cancelled (the
    // money moved). "A real booking" excludes cancellations — a client whose only
    // order was cancelled has still never run a live transaction end to end.
    prev.paidCents += o._sum.amount_paid_cents ?? 0;
    if (o.status !== 'CANCELLED') prev.booked += o._count._all;
    orderFacts.set(o.operator_id, prev);
  }

  const fleetFacts = new Map<string, { total: number; linked: number }>();
  for (const r of resources) {
    const prev = fleetFacts.get(r.operator_id) ?? { total: 0, linked: 0 };
    prev.total += 1;
    if (r._count.activities > 0) prev.linked += 1;
    fleetFacts.set(r.operator_id, prev);
  }

  // --- build each client's checks ------------------------------------------
  for (const op of operators) {
    const active = activitiesByOperator.get(op.id) ?? [];
    const orders = orderFacts.get(op.id) ?? { booked: 0, paidCents: 0 };

    const checks = buildChecks({
      operator: op,
      now,
      locations: locationCount.get(op.id) ?? 0,
      totalActivities: totalActivityCount.get(op.id) ?? 0,
      activeActivities: active,
      ratedActivityIds,
      slotHorizonByActivity,
      waivers: waiverCount.get(op.id) ?? 0,
      fees: feeFacts.get(op.id) ?? { count: 0, total: 0 },
      owners: ownerCount.get(op.id) ?? 0,
      bookings: orders.booked,
      fleet: fleetFacts.get(op.id) ?? { total: 0, linked: 0 },
    });

    const score = scoreChecks(checks);
    result.set(op.id, {
      operatorId: op.id,
      checks,
      ...score,
      topBlocker: pickTopBlocker(checks),
      scheduleHorizonDays: shortestHorizonDays(active, slotHorizonByActivity, now),
      derivedStage: deriveStage({
        blockedCount: score.blockedCount,
        hasBooking: orders.booked > 0,
        hasActiveActivity: active.length > 0,
      }),
      bookingCount: orders.booked,
      paidRevenueCents: orders.paidCents,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// The checks themselves
// ---------------------------------------------------------------------------

interface CheckInput {
  operator: ReadinessOperatorInput;
  now: Date;
  locations: number;
  totalActivities: number;
  activeActivities: ActivityFact[];
  ratedActivityIds: ReadonlySet<string>;
  slotHorizonByActivity: ReadonlyMap<string, Date>;
  waivers: number;
  fees: { count: number; total: number };
  owners: number;
  bookings: number;
  fleet: { total: number; linked: number };
}

/**
 * Priority order IS the array order: whatever is unmet highest in this list is the
 * thing the owner should chase today. Login before location, catalog before price,
 * price before schedule — each one is useless until the one above it is done.
 */
function buildChecks(input: CheckInput): ReadinessCheck[] {
  const { activeActivities: active } = input;
  const hasCatalog = active.length > 0;

  return [
    ownerCheck(input),
    locationCheck(input),
    catalogCheck(input),
    ratesCheck(input, hasCatalog),
    scheduleCheck(input, hasCatalog),
    waiverCheck(input),
    feesCheck(input),
    brandingCheck(input),
    fleetCheck(input, hasCatalog),
    firstBookingCheck(input),
  ];
}

function ownerCheck({ owners }: CheckInput): ReadinessCheck {
  return {
    id: 'owner_staff',
    label: 'Owner login',
    status: owners > 0 ? 'OK' : 'BLOCKED',
    court: 'US',
    fixHref: '/staff',
    detail:
      owners > 0
        ? 'Somebody at the client can sign in as the owner and run the business themselves.'
        : 'Nobody at this client can sign in as an owner, so every change has to come through us. Add their owner on the Staff screen with the email they will log in with.',
  };
}

function locationCheck({ locations }: CheckInput): ReadinessCheck {
  return {
    id: 'location',
    label: 'Location',
    status: locations > 0 ? 'OK' : 'BLOCKED',
    court: 'US',
    fixHref: '/settings/locations',
    detail:
      locations > 0
        ? locations === 1
          ? 'They have one site set up, which is all a single-dock operation needs.'
          : `They have ${locations} sites set up.`
        : 'They have no site at all, so activities have nowhere to hang and the manifest cannot group anything. Provisioning normally creates one, so this was deleted — add it back under Locations.',
  };
}

function catalogCheck({ activeActivities, totalActivities }: CheckInput): ReadinessCheck {
  const active = activeActivities.length;
  if (active > 0) {
    return {
      id: 'catalog',
      label: 'Catalog',
      status: 'OK',
      court: 'US',
      fixHref: '/activities',
      detail: `${active} ${active === 1 ? 'activity is' : 'activities are'} switched on and can appear on their booking page.`,
    };
  }
  return {
    id: 'catalog',
    label: 'Catalog',
    status: 'BLOCKED',
    court: 'US',
    fixHref: '/activities',
    detail:
      totalActivities > 0
        ? `They have ${totalActivities} ${totalActivities === 1 ? 'activity' : 'activities'} but every one is switched off, so their booking page is empty. Open Activities and set the ones they are actually selling to Active.`
        : 'Their catalog is empty, so there is nothing to sell. Build their activities from the list they sent, or run the guided setup with them on a call.',
  };
}

function ratesCheck(input: CheckInput, hasCatalog: boolean): ReadinessCheck {
  if (!hasCatalog) {
    return {
      id: 'rates',
      label: 'Prices',
      status: 'BLOCKED',
      court: 'US',
      fixHref: '/activities',
      detail: 'Nothing is priced because nothing is in the catalog yet. Build the activities first.',
    };
  }
  const unpriced = input.activeActivities.filter((a) => !input.ratedActivityIds.has(a.id));
  if (unpriced.length === 0) {
    return {
      id: 'rates',
      label: 'Prices',
      status: 'OK',
      court: 'US',
      fixHref: '/activities',
      detail: 'Every active activity has at least one price a guest can buy.',
    };
  }
  const first = unpriced[0];
  return {
    id: 'rates',
    label: 'Prices',
    status: 'BLOCKED',
    court: 'US',
    // Straight to the offending activity — the wizard's rates step is right there.
    fixHref: `/activities/${first.id}`,
    detail:
      unpriced.length === 1
        ? `"${first.name}" is switched on but has no price, so a guest who picks it cannot check out. Add a rate to it.`
        : `${unpriced.length} active activities have no price and cannot be checked out, starting with "${first.name}". Add a rate to each.`,
  };
}

function scheduleCheck(input: CheckInput, hasCatalog: boolean): ReadinessCheck {
  if (!hasCatalog) {
    return {
      id: 'schedule',
      label: 'Schedule',
      status: 'BLOCKED',
      court: 'US',
      fixHref: '/calendar',
      detail: 'There is nothing to schedule until the catalog exists.',
    };
  }

  const empty = input.activeActivities.filter((a) => !input.slotHorizonByActivity.has(a.id));
  if (empty.length > 0) {
    const first = empty[0];
    return {
      id: 'schedule',
      label: 'Schedule',
      status: 'BLOCKED',
      court: 'US',
      fixHref: `/activities/${first.id}`,
      detail:
        empty.length === 1
          ? `"${first.name}" has no bookable times left, so it is invisible to guests even though it is switched on. Open it and extend the schedule.`
          : `${empty.length} active activities have no bookable times left and are invisible to guests, starting with "${first.name}". Extend their schedules.`,
    };
  }

  const soonest = shortestHorizon(input.activeActivities, input.slotHorizonByActivity);
  const days = soonest ? differenceInCalendarDays(soonest.until, input.now) : null;

  if (soonest && days !== null && days <= SCHEDULE_WARN_DAYS) {
    return {
      id: 'schedule',
      label: 'Schedule',
      status: 'WARN',
      court: 'US',
      fixHref: `/activities/${soonest.activity.id}`,
      // Nothing errors when a schedule runs out — the activity just stops being
      // bookable. Which is exactly why it has to be flagged before it happens.
      detail: `"${soonest.activity.name}" has bookable times for only ${days} more ${days === 1 ? 'day' : 'days'}. When they run out it silently stops taking bookings and nobody finds out until the phone stops ringing. Extend it now.`,
    };
  }

  return {
    id: 'schedule',
    label: 'Schedule',
    status: 'OK',
    court: 'US',
    fixHref: '/calendar',
    detail:
      days === null
        ? 'Every active activity has bookable times ahead of it.'
        : `Every active activity is bookable for at least ${days} more days.`,
  };
}

function waiverCheck({ waivers }: CheckInput): ReadinessCheck {
  return {
    id: 'waiver',
    label: 'Waiver',
    status: waivers > 0 ? 'OK' : 'BLOCKED',
    court: 'US',
    fixHref: '/settings/policies',
    detail:
      waivers > 0
        ? 'They have an active waiver, so guests can sign before they get on the water.'
        : 'They have no active waiver, so any activity that requires one will stop dead at check-in with people standing on the dock. Provisioning creates a default, so this one was removed — put their signed text back before they take bookings.',
  };
}

function feesCheck({ fees }: CheckInput): ReadinessCheck {
  if (fees.count === 0) {
    return {
      id: 'fees',
      label: 'Taxes & fees',
      status: 'WARN',
      court: 'THE_CLIENT',
      fixHref: '/settings/fees',
      detail:
        'No tax or fee lines exist at all. If they genuinely charge no tax that is a real answer — add a 0% line so it reads as a decision rather than something we forgot, and so nobody has to ask again.',
    };
  }
  // A zero total is a legitimate configuration, not an omission: some operators
  // quote all-in prices and remit tax themselves. What we cannot accept is silence.
  return {
    id: 'fees',
    label: 'Taxes & fees',
    status: 'OK',
    court: 'THE_CLIENT',
    fixHref: '/settings/fees',
    detail:
      fees.total === 0
        ? `They have ${fees.count} fee ${fees.count === 1 ? 'line' : 'lines'} set to zero. That is a deliberate all-in price, not a gap.`
        : `They have ${fees.count} tax or fee ${fees.count === 1 ? 'line' : 'lines'} configured, so checkout totals are theirs and not a guess.`,
  };
}

function brandingCheck({ operator }: CheckInput): ReadinessCheck {
  const hasLogo = Boolean(operator.logoDarkUrl || operator.logoLightUrl);
  const colorChanged = operator.brandColor.toLowerCase() !== DEFAULT_BRAND_COLOR;
  if (hasLogo || colorChanged) {
    return {
      id: 'branding',
      label: 'Branding',
      status: 'OK',
      court: 'THE_CLIENT',
      fixHref: '/settings/branding',
      detail: hasLogo
        ? 'Their logo is loaded, so the booking page looks like their business.'
        : 'They have picked their own brand colour, so the booking page is not stock.',
    };
  }
  return {
    id: 'branding',
    label: 'Branding',
    status: 'WARN',
    court: 'THE_CLIENT',
    fixHref: '/settings/branding',
    detail:
      'Still the stock blue with no logo, so their booking page looks like a demo rather than their business. Ask them for a logo file and their colour, then set both under Branding.',
  };
}

function fleetCheck(input: CheckInput, hasCatalog: boolean): ReadinessCheck {
  const shared = input.activeActivities.filter((a) => RESOURCE_BACKED.has(a.category));
  if (!hasCatalog || shared.length === 0) {
    return {
      id: 'fleet',
      label: 'Fleet',
      status: 'NOT_APPLICABLE',
      court: 'US',
      fixHref: '/settings/resources',
      detail: hasCatalog
        ? 'Nothing they sell is backed by shared kit, so there is no fleet to track.'
        : 'Not knowable until the catalog exists.',
    };
  }
  if (input.fleet.total === 0) {
    return {
      id: 'fleet',
      label: 'Fleet',
      status: 'WARN',
      court: 'US',
      fixHref: '/settings/resources',
      // Without resources each activity counts capacity alone, so the same boat can
      // be sold twice through two different activities and nothing stops it.
      detail: `They sell ${shared.length} ${shared.length === 1 ? 'activity' : 'activities'} off shared kit but no boats or gear are recorded. Until the fleet is entered, two activities can sell the same boat for the same afternoon. Add their fleet under Resources.`,
    };
  }
  if (input.fleet.linked === 0) {
    return {
      id: 'fleet',
      label: 'Fleet',
      status: 'WARN',
      court: 'US',
      fixHref: '/settings/resources',
      detail: `Their ${input.fleet.total} recorded ${input.fleet.total === 1 ? 'resource is' : 'resources are'} not attached to any activity, so nothing is protected from being double-sold. Link each one to the activities it backs.`,
    };
  }
  return {
    id: 'fleet',
    label: 'Fleet',
    status: 'OK',
    court: 'US',
    fixHref: '/settings/resources',
    detail: `${input.fleet.linked} of ${input.fleet.total} recorded ${input.fleet.total === 1 ? 'resource is' : 'resources are'} attached to activities, so shared kit cannot be sold twice.`,
  };
}

function firstBookingCheck({ bookings }: CheckInput): ReadinessCheck {
  return {
    id: 'first_booking',
    label: 'First booking',
    // A milestone, not a configuration gap — everything can be right and the first
    // guest still has not arrived. It should nudge, not shout.
    status: bookings > 0 ? 'OK' : 'WARN',
    court: 'THE_CLIENT',
    fixHref: '/orders',
    detail:
      bookings > 0
        ? `They have taken ${bookings} ${bookings === 1 ? 'booking' : 'bookings'}, so the whole path from booking page to money has run for real.`
        : 'Nobody has ever booked through them, so no part of this has been proven end to end. Walk them through taking one test booking on a call — that is the moment onboarding actually lands.',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countByOperator(
  rows: readonly { operator_id: string; _count: { _all: number } }[],
): Map<string, number> {
  return new Map(rows.map((r) => [r.operator_id, r._count._all]));
}

/** The active activity whose bookable schedule ends soonest, if any is scheduled. */
function shortestHorizon(
  activities: readonly ActivityFact[],
  horizons: ReadonlyMap<string, Date>,
): { activity: ActivityFact; until: Date } | null {
  let soonest: { activity: ActivityFact; until: Date } | null = null;
  for (const activity of activities) {
    const until = horizons.get(activity.id);
    if (!until) continue;
    if (!soonest || until < soonest.until) soonest = { activity, until };
  }
  return soonest;
}

function shortestHorizonDays(
  activities: readonly ActivityFact[],
  horizons: ReadonlyMap<string, Date>,
  now: Date,
): number | null {
  if (activities.length === 0) return null;
  // An active activity with no future slot is a zero-day horizon, not "unknown".
  if (activities.some((a) => !horizons.has(a.id))) return 0;
  const soonest = shortestHorizon(activities, horizons);
  return soonest ? Math.max(0, differenceInCalendarDays(soonest.until, now)) : null;
}
