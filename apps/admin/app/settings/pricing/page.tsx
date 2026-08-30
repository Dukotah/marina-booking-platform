import { revalidatePath } from 'next/cache';
import { PricingRuleKind as PrismaPricingRuleKind, type Prisma } from '@marina/database';
import {
  DEFAULT_PRICE_GUARDRAILS,
  PRICING_RULE_KINDS,
  resolveDynamicPrice,
  type DynamicPricingRule,
} from '@marina/core';
import { AuthorizationError } from '@marina/auth';
import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission } from '../../../lib/session';
import {
  PricingRules,
  type ActionResult,
  type ActivityOption,
  type PreviewOutcome,
  type PreviewPayload,
  type PricingRuleDraft,
  type PricingRuleRow,
  type RuleKind,
} from '../../../components/settings/PricingRules';

export const dynamic = 'force-dynamic';

/**
 * Dynamic pricing (Track B §B3 / Local-First §7 "Dynamic pricing: seasonal,
 * weekend, demand, guide markup").
 *
 * The admin app talks to the database directly through the tenant-scoped client
 * (D-007), so these server actions are the write path — the API's
 * `/api/pricing-rules` router serves the customer app and any external caller.
 * BOTH sides resolve prices with the same `@marina/core` engine, which is what
 * makes the preview on this page an honest prediction rather than a second
 * implementation that agrees until it doesn't.
 *
 * SCHEMA CAPABILITY. `PricingRuleKind` currently has four values. The engine also
 * implements TIME_OF_DAY (sunset premium) and LEAD_TIME (last-minute / early
 * bird); those two are fully previewable here and become saveable the moment the
 * enum values and their window columns exist — `PERSISTABLE_KINDS` is read from
 * the generated Prisma enum, so nothing here needs editing when that lands.
 */

const PERSISTABLE_KINDS: RuleKind[] = PRICING_RULE_KINDS.filter(
  (k) => k in PrismaPricingRuleKind,
) as RuleKind[];

const ROUTE = '/settings/pricing';

// ===========================================================================
// Row <-> draft mapping
// ===========================================================================

/**
 * The window columns the two extended kinds need. Optional on the row type so
 * this file compiles both before and after the migration that adds them.
 */
interface ExtendedColumns {
  start_minute: number | null;
  end_minute: number | null;
  min_lead_minutes: number | null;
  max_lead_minutes: number | null;
}

type RuleRecord = {
  id: string;
  name: string;
  kind: string;
  adjustment_type: string;
  adjustment_value: number;
  is_active: boolean;
  priority: number;
  activity_id: string | null;
  rate_id: string | null;
  starts_on: Date | null;
  ends_on: Date | null;
  weekdays: number[];
  demand_threshold: number | null;
} & Partial<ExtendedColumns>;

function toRow(record: RuleRecord): PricingRuleRow {
  return {
    id: record.id,
    priority: record.priority,
    name: record.name,
    kind: record.kind as RuleKind,
    adjustmentType: record.adjustment_type as 'PERCENT' | 'FLAT',
    adjustmentValue: record.adjustment_value,
    isActive: record.is_active,
    activityId: record.activity_id,
    rateId: record.rate_id,
    startsOn: record.starts_on ? record.starts_on.toISOString() : null,
    endsOn: record.ends_on ? record.ends_on.toISOString() : null,
    weekdays: record.weekdays,
    startMinute: record.start_minute ?? null,
    endMinute: record.end_minute ?? null,
    minLeadMinutes: record.min_lead_minutes ?? null,
    maxLeadMinutes: record.max_lead_minutes ?? null,
    demandThreshold: record.demand_threshold ?? null,
  };
}

/** A stored row (or an unsaved draft) in the shape the pricing engine reads. */
function toEngineRule(row: PricingRuleRow | (PricingRuleDraft & { id: string })): DynamicPricingRule {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    adjustmentType: row.adjustmentType,
    adjustmentValue: row.adjustmentValue,
    priority: 'priority' in row ? row.priority : 0,
    isActive: row.isActive,
    activityId: row.activityId,
    rateId: row.rateId,
    startsOn: row.startsOn ? new Date(row.startsOn) : null,
    endsOn: row.endsOn ? new Date(row.endsOn) : null,
    weekdays: row.weekdays,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    minLeadMinutes: row.minLeadMinutes,
    maxLeadMinutes: row.maxLeadMinutes,
    demandThreshold: row.demandThreshold,
  };
}

// ===========================================================================
// Validation
// ===========================================================================

const MAX_PERCENT = 1_000;
const MAX_FLAT_CENTS = 1_000_000;

/**
 * Cross-field checks the form cannot express. Mirrors
 * `apps/api/src/services/pricing-rules.ts#validatePricingRuleInput` — the admin
 * writes straight to the database (D-007), so the rules have to hold on this side
 * too. Returns an operator-facing message, or null when the rule is sound.
 */
function validate(draft: PricingRuleDraft): string | null {
  if (!draft.name.trim()) return 'Give the rule a name.';
  if (!PRICING_RULE_KINDS.includes(draft.kind)) return 'Pick when the rule applies.';

  if (draft.adjustmentType === 'PERCENT') {
    if (!Number.isFinite(draft.adjustmentValue) || Math.abs(draft.adjustmentValue) > MAX_PERCENT) {
      return `A percentage adjustment must be between -${MAX_PERCENT}% and ${MAX_PERCENT}%.`;
    }
  } else if (
    !Number.isInteger(draft.adjustmentValue) ||
    Math.abs(draft.adjustmentValue) > MAX_FLAT_CENTS
  ) {
    return 'A flat adjustment must be within ±$10,000.';
  }
  if (draft.adjustmentValue === 0) return 'A rule that adjusts by zero does nothing.';

  switch (draft.kind) {
    case 'SEASONAL':
      if (draft.startsOn && draft.endsOn && new Date(draft.startsOn) > new Date(draft.endsOn)) {
        return 'The season ends before it starts.';
      }
      return null;
    case 'WEEKEND':
      if (draft.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
        return 'Weekdays must be Monday through Sunday.';
      }
      return null;
    case 'TIME_OF_DAY':
      if (draft.startMinute == null || draft.endMinute == null) {
        return 'A time-of-day rule needs both a start and an end time.';
      }
      return null;
    case 'LEAD_TIME':
      if (draft.minLeadMinutes == null && draft.maxLeadMinutes == null) {
        return 'A lead-time rule needs a minimum, a maximum, or both.';
      }
      if (
        draft.minLeadMinutes != null &&
        draft.maxLeadMinutes != null &&
        draft.minLeadMinutes > draft.maxLeadMinutes
      ) {
        return 'The minimum lead time is longer than the maximum, so nothing can match.';
      }
      return null;
    case 'DEMAND':
      if (draft.demandThreshold == null || draft.demandThreshold < 0 || draft.demandThreshold > 1) {
        return 'A demand rule needs a threshold between 0% and 100%.';
      }
      return null;
    case 'GUIDE_MARKUP':
      return null;
  }
}

/**
 * Scalars for a write. Fields belonging to other kinds are explicitly cleared so
 * changing a rule's type can never leave a stale window behind.
 */
function scalars(draft: PricingRuleDraft) {
  const extended =
    draft.kind === 'TIME_OF_DAY'
      ? { start_minute: draft.startMinute, end_minute: draft.endMinute }
      : draft.kind === 'LEAD_TIME'
        ? { min_lead_minutes: draft.minLeadMinutes, max_lead_minutes: draft.maxLeadMinutes }
        : {};

  return {
    name: draft.name.trim(),
    kind: draft.kind,
    adjustment_type: draft.adjustmentType,
    adjustment_value: Math.trunc(draft.adjustmentValue),
    is_active: draft.isActive,
    activity_id: draft.activityId,
    rate_id: draft.rateId,
    starts_on: draft.kind === 'SEASONAL' && draft.startsOn ? new Date(draft.startsOn) : null,
    ends_on: draft.kind === 'SEASONAL' && draft.endsOn ? new Date(draft.endsOn) : null,
    weekdays: draft.kind === 'WEEKEND' ? draft.weekdays : [],
    demand_threshold: draft.kind === 'DEMAND' ? draft.demandThreshold : null,
    ...extended,
  };
}

function denied(): ActionResult {
  return { ok: false, message: 'You do not have permission to manage pricing.' };
}

/** A kind the current schema cannot store yet gets a precise message, not a crash. */
function kindGuard(kind: RuleKind): string | null {
  if (PERSISTABLE_KINDS.includes(kind)) return null;
  return `“${kind}” rules need the pricing-rule window migration before they can be saved. You can still preview them.`;
}

// ===========================================================================
// Server actions
// ===========================================================================

async function createRule(draft: PricingRuleDraft): Promise<ActionResult> {
  'use server';
  try {
    const { operatorId } = await requirePermission('operator:manage');
    const problem = validate(draft) ?? kindGuard(draft.kind);
    if (problem) return { ok: false, message: problem };

    const db = await getTenantDb();
    // New rules go to the end of the list; the operator reorders from there.
    const last = await db.pricingRule.findFirst({
      orderBy: { priority: 'desc' },
      select: { priority: true },
    });

    // Top-level create: operator_id is explicit (D-011).
    await db.pricingRule.create({
      data: {
        operator_id: operatorId,
        priority: (last?.priority ?? -1) + 1,
        ...scalars(draft),
      } as Prisma.PricingRuleUncheckedCreateInput,
    });

    revalidatePath(ROUTE);
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

async function updateRule(id: string, draft: PricingRuleDraft): Promise<ActionResult> {
  'use server';
  try {
    await requirePermission('operator:manage');
    const problem = validate(draft) ?? kindGuard(draft.kind);
    if (problem) return { ok: false, message: problem };

    const db = await getTenantDb();
    // updateMany, not update: RLS scopes the row, and a count of 0 is a clean
    // "not found" instead of a thrown P2025 that has to be translated.
    const { count } = await db.pricingRule.updateMany({
      where: { id },
      data: scalars(draft) as Prisma.PricingRuleUncheckedUpdateInput,
    });
    if (count === 0) return { ok: false, message: 'That rule no longer exists.' };

    revalidatePath(ROUTE);
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

async function deleteRule(id: string): Promise<ActionResult> {
  'use server';
  try {
    await requirePermission('operator:manage');
    const db = await getTenantDb();
    const { count } = await db.pricingRule.deleteMany({ where: { id } });
    if (count === 0) return { ok: false, message: 'That rule no longer exists.' };
    revalidatePath(ROUTE);
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

async function toggleRule(id: string, isActive: boolean): Promise<ActionResult> {
  'use server';
  try {
    await requirePermission('operator:manage');
    const db = await getTenantDb();
    const { count } = await db.pricingRule.updateMany({
      where: { id },
      data: { is_active: isActive },
    });
    if (count === 0) return { ok: false, message: 'That rule no longer exists.' };
    revalidatePath(ROUTE);
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

/**
 * Renumber priorities densely from the given order. Dense 0..n-1 rather than
 * nudged values, so repeated reordering can never drift into duplicates where the
 * engine's id tiebreaker — not the operator's intent — decides the winner.
 */
async function reorderRules(orderedIds: string[]): Promise<ActionResult> {
  'use server';
  try {
    await requirePermission('operator:manage');
    const db = await getTenantDb();
    for (let i = 0; i < orderedIds.length; i++) {
      await db.pricingRule.updateMany({ where: { id: orderedIds[i]! }, data: { priority: i } });
    }
    revalidatePath(ROUTE);
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

/**
 * Price a hypothetical booking. Loads the rate's REAL list price and the stored
 * rules, splices in the unsaved draft (replacing the stored rule it is an edit
 * of, matched by id), and runs the identical engine call the booking path runs.
 */
async function previewRule(input: PreviewPayload): Promise<PreviewOutcome> {
  'use server';
  try {
    const { operatorId } = await requirePermission('activity:read');
    const db = await getTenantDb();

    const rate = await db.rate.findUnique({
      where: { id: input.rateId },
      select: {
        price_cents: true,
        name_external: true,
        activity_id: true,
        activity: { select: { name_external: true } },
      },
    });
    if (!rate) return { ok: false, message: 'That rate no longer exists.' };
    if (rate.activity_id !== input.activityId) {
      return { ok: false, message: 'That rate belongs to a different activity.' };
    }

    const stored = (await db.pricingRule.findMany({
      where: {
        OR: [
          { rate_id: input.rateId },
          { rate_id: null, activity_id: input.activityId },
          { rate_id: null, activity_id: null },
        ],
      },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    })) as RuleRecord[];

    const rules: DynamicPricingRule[] = stored
      // An edit replaces its stored self, so the preview shows the rule as it
      // WOULD be, not the rule as it is plus the rule as it would be.
      .filter((r) => r.id !== input.replacesRuleId)
      .map((r) => toEngineRule(toRow(r)));
    if (input.draftRule) {
      // Keep the stored priority for an edit (and put a brand-new rule last, where
      // `createRule` will actually put it) — otherwise the preview would let the
      // draft win ties it would lose once saved.
      const replaced = stored.find((r) => r.id === input.replacesRuleId);
      const priority =
        replaced?.priority ?? stored.reduce((max, r) => Math.max(max, r.priority + 1), 0);
      rules.push({ ...toEngineRule(input.draftRule), priority });
    }

    const total = Math.max(0, Math.trunc(input.capacityTotal));
    const booked = Math.max(0, Math.trunc(input.capacityBooked));
    const result = resolveDynamicPrice(
      rate.price_cents,
      rules,
      {
        slotStart: new Date(input.slotStart),
        now: new Date(input.bookingAt),
        // 0 seats is "unknown", not "empty": a demand rule must not fire on a guess.
        bookedRatio: total > 0 ? Math.min(1, booked / total) : null,
        activityId: input.activityId,
        rateId: input.rateId,
      },
      DEFAULT_PRICE_GUARDRAILS,
    );

    // Named for the operator, not for the engine: `supersededBy` becomes the
    // winning rule's NAME, because "beaten by cmf2k9..." explains nothing.
    const nameById = new Map<string, string>(rules.map((r) => [r.id, r.name ?? r.id]));

    return {
      ok: true,
      result: {
        activityName: rate.activity.name_external,
        rateName: rate.name_external,
        basePriceCents: result.basePriceCents,
        priceCents: result.priceCents,
        rawPriceCents: result.rawPriceCents,
        floorCents: result.floorCents,
        ceilingCents: result.ceilingCents,
        clampedBy: result.clampedBy,
        applied: result.applied.map((a) => ({
          ruleId: a.ruleId,
          name: a.name,
          kind: a.kind as RuleKind,
          deltaCents: a.deltaCents,
        })),
        suppressed: result.suppressed.map((s) => ({
          ruleId: s.ruleId,
          name: s.name,
          kind: s.kind as RuleKind,
          reason: s.reason,
          supersededBy: nameById.get(s.supersededByRuleId) ?? s.supersededByRuleId,
        })),
      },
    };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, message: 'You do not have permission to preview pricing.' };
    }
    // Money maths throws rather than guessing (MoneyError). Surface it instead of
    // a blank panel — an operator needs to know their rule is the problem.
    return { ok: false, message: err instanceof Error ? err.message : 'Could not price that.' };
  }
}

// ===========================================================================
// Page
// ===========================================================================

/**
 * Dynamic pricing settings. Tenant-scoped via getTenantDb (RLS); reading is gated
 * on activity:read so a manager can inspect and preview, writing on
 * operator:manage inside each action.
 */
export default async function PricingSettingsPage() {
  await requirePermission('activity:read');
  const db = await getTenantDb();

  const [ruleRecords, activities] = await Promise.all([
    db.pricingRule.findMany({ orderBy: [{ priority: 'asc' }, { id: 'asc' }] }),
    db.activity.findMany({
      orderBy: { name_internal: 'asc' },
      select: {
        id: true,
        name_internal: true,
        rates: {
          where: { is_active: true },
          orderBy: { sort_index: 'asc' },
          select: { id: true, name_external: true, price_cents: true },
        },
      },
    }),
  ]);

  const rules: PricingRuleRow[] = (ruleRecords as RuleRecord[]).map(toRow);
  const activityOptions: ActivityOption[] = activities.map((a) => ({
    id: a.id,
    name: a.name_internal,
    rates: a.rates.map((r) => ({ id: r.id, name: r.name_external, priceCents: r.price_cents })),
  }));

  return (
    <>
      <PageHeader
        title="Dynamic Pricing"
        description="Charge more when demand is high and less when it isn't — seasons, weekends, sunset trips, lead time and occupancy."
      />
      <PricingRules
        rules={rules}
        activities={activityOptions}
        persistableKinds={PERSISTABLE_KINDS}
        onCreate={createRule}
        onUpdate={updateRule}
        onDelete={deleteRule}
        onToggle={toggleRule}
        onReorder={reorderRules}
        onPreview={previewRule}
      />
    </>
  );
}
