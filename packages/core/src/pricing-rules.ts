/**
 * Dynamic pricing rules — the engine that turns a rate's list price into the
 * price this particular slot is actually worth.
 *
 * A marina's revenue is not evenly distributed: a July Saturday at 5pm with two
 * seats left is worth two or three times a wet Tuesday morning in April, and
 * charging one price for both is the single largest pile of money an operator
 * leaves on the table. This module makes that difference expressible as data an
 * operator can edit, and — just as importantly — *predict*.
 *
 * It EXTENDS `pricing.ts` rather than replacing it. `calculatePricing` still owns
 * the order of operations for discounts, fees, tax and tips; this module owns one
 * number that feeds into it: the per-unit price of a line item. The composition is
 * literally one line:
 *
 *     const dyn = resolveDynamicPrice(rate.price_cents, rules, ctx);
 *     calculatePricing({ items: [{ unitPriceCents: dyn.priceCents, quantity }], ... });
 *
 * `resolveEffectivePrice` in `pricing.ts` was the first pass at this. It composes
 * rules by multiplying a *running* price, which has two defects this module exists
 * to fix, both of which cost real money:
 *
 *   1. **Order dependence.** +10% then +$5 is not +$5 then +10%. Its input came
 *      straight out of a `findMany`, so the price a guest saw could depend on the
 *      order Postgres happened to return rows in.
 *   2. **Compounded rounding.** Each percentage rounded to a whole cent before the
 *      next one was applied, so a three-rule stack rounded three times and drifted
 *      from the exact value — the classic "percentage of a percentage" bug.
 *
 * ---------------------------------------------------------------------------
 * THE PRECEDENCE CONTRACT (this is the part to read)
 * ---------------------------------------------------------------------------
 *
 * Five stages, in this order. The result of every stage is a pure function of the
 * rule *set* and the context — never of iteration order, insert order, or the
 * order a database returned rows in.
 *
 *   A. CANDIDACY — a rule is a candidate when it is enabled, its scope covers the
 *      activity/rate being priced, and its own condition matches the context
 *      (`ruleMatches`). Non-candidates are invisible from here on.
 *
 *   B. SPECIFICITY — candidates are grouped by `kind`. Within a kind only the most
 *      specific scope tier present survives: a rule bound to this RATE beats one
 *      bound to this ACTIVITY, which beats an operator-wide rule. Rationale: an
 *      operator who adds "no weekend surcharge on kayaks" means *instead of*, not
 *      *on top of*. Silently stacking an override with the thing it overrides is
 *      how a guest gets charged twice for one weekend.
 *
 *   C. SELECTION — within a kind, exactly ONE rule wins. Two seasonal windows that
 *      both contain a date (say "Summer +15%" and "July 4th week +30%") are
 *      alternatives, not addends. The winner is the lowest `priority`; ties break
 *      on `id` ascending. `id` is the tiebreaker rather than `created_at` because
 *      two rules created in the same transaction share a timestamp — `id` is
 *      unique by construction, so the ordering is a genuine total order and the
 *      outcome cannot change between two reads of the same data.
 *
 *   D. COMPOSITION — the winners (at most one per kind) are combined against the
 *      BASE price, never against a running total:
 *
 *          price = base + round(base * Σpercent) + Σflat
 *
 *      Every percentage is a share of the same base and they are summed as EXACT
 *      rationals (via `percentToRational`), so the whole percentage stack rounds
 *      exactly once. Addition is commutative, so at this point the order of the
 *      winners is provably irrelevant to the result. "+20% weekend, +10% holiday"
 *      is +30% of base, which is also what an operator reading the two rules
 *      expects — not the 32% that compounding produces.
 *
 *   E. GUARDRAILS — the composed price is clamped into `[floor, ceiling]`, derived
 *      from the base price by multiplier (see `PriceGuardrails`). Demand and
 *      seasonal discounts stack, and a stack of discounts with a fat flat
 *      adjustment can otherwise go negative; a mis-typed `2000` in a percent field
 *      can otherwise 20x a booking. Neither should ever reach a guest, and neither
 *      should silently fail the booking either — clamping keeps the sale.
 *
 * ---------------------------------------------------------------------------
 * QUOTED PRICE == CHARGED PRICE
 * ---------------------------------------------------------------------------
 *
 * Rules can be edited while a guest has a checkout page open. The guarantee is
 * that whatever price we *showed* is the price we *take*, and it is built from
 * three pieces here:
 *
 *   - `quoteFingerprint` reduces a quote to a canonical string: tenant, activity,
 *     rate, slot, quantity, the resolved unit price, and the sorted ids of the
 *     rules that produced it. Same inputs => byte-identical string, on any machine.
 *   - The API signs that string (HMAC) and hands the token to the browser. The
 *     price is therefore not something the client can edit — a tampered price or
 *     rule set fails verification.
 *   - At checkout the server RE-RESOLVES from live rules and calls
 *     `reconcileQuote`. If the number still matches, nothing happened. If a rule
 *     changed underneath the guest, the *quoted* price is honoured as long as the
 *     signature is valid and the quote has not expired (`PRICE_QUOTE_TTL_SECONDS`,
 *     15 minutes) — we eat the difference rather than surprise them at the card
 *     form. Past the TTL, or with no valid signature, we re-price and the guest
 *     must see and accept the new number before anything is charged.
 *
 * The TTL is what makes honouring safe: an operator's price change takes effect
 * for everyone within fifteen minutes, and nobody is ever charged a number they
 * were not shown.
 *
 * Everything in this file is pure, DB-free and clock-free (time enters only
 * through `PricingContext`), so it runs identically in the API, in the admin
 * preview, and in a unit test.
 */
import { assertCents, percentToRational, prorate, roundCents } from './money.js';

// ===========================================================================
// Rule shape
// ===========================================================================

/**
 * The conditions a marina actually prices on.
 *
 *   - `SEASONAL`    — a date range. "Memorial Day to Labor Day, +20%."
 *   - `WEEKEND`     — days of the week. "Saturday and Sunday, +15%."
 *   - `TIME_OF_DAY` — a clock window on the slot's start. "Sunset cruise, +$25."
 *   - `LEAD_TIME`   — how far ahead of the slot the booking is made. Both the
 *                     last-minute discount ("inside 24h, -20%, fill the boat")
 *                     and the early-bird ("30+ days out, -10%, bank the cash").
 *   - `DEMAND`      — how full the slot already is. "80% booked, +25%."
 *   - `GUIDE_MARKUP`— an unconditional surcharge on the rates it is scoped to,
 *                     for guided variants.
 */
export type PricingRuleKind =
  | 'SEASONAL'
  | 'WEEKEND'
  | 'TIME_OF_DAY'
  | 'LEAD_TIME'
  | 'DEMAND'
  | 'GUIDE_MARKUP';

/** Every kind, in the order the UI and the breakdown present them. */
export const PRICING_RULE_KINDS: readonly PricingRuleKind[] = [
  'SEASONAL',
  'WEEKEND',
  'TIME_OF_DAY',
  'LEAD_TIME',
  'DEMAND',
  'GUIDE_MARKUP',
];

/** Short operator-facing label for each kind. */
export const PRICING_RULE_KIND_LABEL: Record<PricingRuleKind, string> = {
  SEASONAL: 'Season (date range)',
  WEEKEND: 'Day of week',
  TIME_OF_DAY: 'Time of day',
  LEAD_TIME: 'Lead time',
  DEMAND: 'Demand / occupancy',
  GUIDE_MARKUP: 'Guided surcharge',
};

export type PricingAdjustmentType = 'PERCENT' | 'FLAT';

/** Which weekdays a WEEKEND rule fires on when none are configured: Sat + Sun. */
export const DEFAULT_WEEKEND_DAYS: readonly number[] = [6, 7]; // ISO 6=Sat, 7=Sun

/** Minutes in a day — the modulus for every TIME_OF_DAY comparison. */
const MINUTES_PER_DAY = 24 * 60;

/**
 * One composable rule. Decoupled from Prisma so the engine is unit-testable and
 * so the admin can price an UNSAVED draft — an operator will not trust a rule
 * they cannot see the effect of before saving.
 *
 * Only the fields relevant to a given `kind` are read, so a caller can hand over
 * a whole database row without filtering it.
 */
export interface DynamicPricingRule {
  /** Stable unique id. Doubles as the deterministic tiebreaker in stage C. */
  id: string;
  /** Operator-facing name, echoed into the breakdown so a price explains itself. */
  name?: string;
  kind: PricingRuleKind;
  adjustmentType: PricingAdjustmentType;
  /** PERCENT: a percentage delta (+15 => +15%, -10 => -10%). FLAT: integer cents (may be negative). */
  adjustmentValue: number;
  /** Lower wins within a kind. Defaults to 0. */
  priority?: number;
  /** `false` disables the rule outright. Defaults to enabled. */
  isActive?: boolean;

  // --- Scope. Both null => applies to every rate the operator sells. ---
  activityId?: string | null;
  rateId?: string | null;

  // --- SEASONAL: inclusive calendar window. Time-of-day on these is ignored. ---
  startsOn?: Date | null;
  endsOn?: Date | null;

  // --- WEEKEND: ISO weekdays (1=Mon..7=Sun). Empty/absent => Sat+Sun. ---
  weekdays?: readonly number[] | null;

  // --- TIME_OF_DAY: minutes from local midnight, inclusive of both ends.
  //     `endMinute < startMinute` wraps past midnight (a 22:00–02:00 night rate). ---
  startMinute?: number | null;
  endMinute?: number | null;

  // --- LEAD_TIME: minutes between "now" and the slot start.
  //     minLeadMinutes = early-bird floor, maxLeadMinutes = last-minute ceiling.
  //     A slot already in the past has a negative lead time and matches neither. ---
  minLeadMinutes?: number | null;
  maxLeadMinutes?: number | null;

  // --- DEMAND: fires when the slot's booked ratio has reached this (0..1). ---
  demandThreshold?: number | null;
}

/**
 * Everything the engine is allowed to know about the thing being priced. Time is
 * a parameter, never `Date.now()`, so the sandbox clock control (and every test)
 * can move it.
 */
export interface PricingContext {
  /** Start of the slot being priced. Drives SEASONAL, WEEKEND and TIME_OF_DAY. */
  slotStart: Date;
  /**
   * The moment the quote is being made, for LEAD_TIME. Omitted => LEAD_TIME rules
   * never fire, the same way DEMAND rules never fire without a ratio: a rule with
   * no signal to test must not guess.
   */
  now?: Date | null;
  /** Booked/total for this slot, 0..1. Omitted => DEMAND rules never fire. */
  bookedRatio?: number | null;
  /** The activity being priced. Omitted => activity-scoped rules cannot match. */
  activityId?: string | null;
  /** The rate being priced. Omitted => rate-scoped rules cannot match. */
  rateId?: string | null;
}

// ===========================================================================
// Guardrails — the floor and the ceiling
// ===========================================================================

/**
 * The bounds a composed price is clamped into, expressed as multiples of the
 * base price so they scale with the rate instead of needing a number per rate.
 *
 * These are a safety net, not a pricing tool. They exist because a stack of
 * discounts (last-minute -25%, off-season -20%, member -15%) plus a flat
 * adjustment can cross zero, and because `2000` typed into a percent field
 * instead of `20` should cost an operator a confusing invoice, not a lawsuit.
 */
export interface PriceGuardrails {
  /** Lowest allowed price as a multiple of base. 0.25 => never below 25% of list. */
  minMultiplier: number;
  /** Highest allowed price as a multiple of base. 3 => never above 3x list. */
  maxMultiplier: number;
  /** Hard floor in integer cents, applied on top of the multiplier floor. */
  absoluteFloorCents: number;
}

/**
 * Deliberately wide: rules should almost never hit these. A marina that genuinely
 * wants a half-price Tuesday is inside 0.25x; one that wants a 3x holiday rate
 * should say so with a rate, not a rule stack.
 */
export const DEFAULT_PRICE_GUARDRAILS: PriceGuardrails = {
  minMultiplier: 0.25,
  maxMultiplier: 3,
  absoluteFloorCents: 0,
};

// ===========================================================================
// Matching
// ===========================================================================

/** ISO weekday (1=Mon .. 7=Sun) from a date's local day-of-week. */
const isoWeekday = (d: Date): number => {
  const dow = d.getDay(); // 0=Sun..6=Sat
  return dow === 0 ? 7 : dow;
};

/** Local midnight as epoch ms, so SEASONAL compares calendar days not instants. */
const dayFloor = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Minutes since local midnight, 0..1439. */
const minuteOfDay = (d: Date): number => d.getHours() * 60 + d.getMinutes();

/** A finite number, or null. Guards every optional numeric column. */
const finite = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Does this rule's SCOPE cover what we are pricing?
 *
 * A rule with no scope covers everything. A rate-scoped rule requires that exact
 * rate. An activity-scoped rule requires that activity. A context that does not
 * name an activity/rate cannot satisfy a rule that requires one — pricing an
 * unknown thing must not pick up someone else's surcharge.
 */
export const ruleInScope = (rule: DynamicPricingRule, ctx: PricingContext): boolean => {
  if (rule.rateId != null && rule.rateId !== ctx.rateId) return false;
  if (rule.activityId != null && rule.activityId !== ctx.activityId) return false;
  return true;
};

/**
 * Scope specificity, used by stage B. Higher is more specific.
 * 2 = this rate, 1 = this activity, 0 = operator-wide.
 */
export const ruleScopeTier = (rule: DynamicPricingRule): number => {
  if (rule.rateId != null) return 2;
  if (rule.activityId != null) return 1;
  return 0;
};

/**
 * Does this rule's CONDITION hold for this context? Pure, and independent of
 * every other rule — stage A asks this of each rule exactly once.
 */
export const ruleMatches = (rule: DynamicPricingRule, ctx: PricingContext): boolean => {
  switch (rule.kind) {
    case 'SEASONAL': {
      // An unbounded end (or start) is a legitimate open-ended season.
      const day = dayFloor(ctx.slotStart);
      if (rule.startsOn && day < dayFloor(rule.startsOn)) return false;
      if (rule.endsOn && day > dayFloor(rule.endsOn)) return false;
      return true;
    }

    case 'WEEKEND': {
      const days =
        rule.weekdays && rule.weekdays.length > 0 ? rule.weekdays : DEFAULT_WEEKEND_DAYS;
      return days.includes(isoWeekday(ctx.slotStart));
    }

    case 'TIME_OF_DAY': {
      const start = finite(rule.startMinute);
      const end = finite(rule.endMinute);
      // A window with no bounds is not "all day", it is misconfigured. Refusing to
      // fire is the safe direction: an operator notices a rule that did nothing far
      // sooner than one that quietly surcharged every booking.
      if (start == null || end == null) return false;
      const at = minuteOfDay(ctx.slotStart);
      const from = ((Math.trunc(start) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
      const to = ((Math.trunc(end) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
      // Inclusive both ends. from > to wraps midnight (22:00–02:00).
      return from <= to ? at >= from && at <= to : at >= from || at <= to;
    }

    case 'LEAD_TIME': {
      if (!ctx.now) return false; // No clock => no lead-time signal. See PricingContext.
      const min = finite(rule.minLeadMinutes);
      const max = finite(rule.maxLeadMinutes);
      if (min == null && max == null) return false; // Same reasoning as TIME_OF_DAY.
      const leadMinutes = (ctx.slotStart.getTime() - ctx.now.getTime()) / 60_000;
      if (min != null && leadMinutes < min) return false;
      if (max != null && leadMinutes > max) return false;
      return true;
    }

    case 'DEMAND': {
      const threshold = finite(rule.demandThreshold);
      const ratio = finite(ctx.bookedRatio);
      if (threshold == null || ratio == null) return false;
      return ratio >= threshold;
    }

    case 'GUIDE_MARKUP':
      // Unconditional: the scope (which rates) IS the condition.
      return true;

    default:
      return false;
  }
};

/** Enabled + in scope + condition holds. Stage A in one predicate. */
export const isRuleCandidate = (rule: DynamicPricingRule, ctx: PricingContext): boolean =>
  rule.isActive !== false && ruleInScope(rule, ctx) && ruleMatches(rule, ctx);

// ===========================================================================
// Selection — stages B and C
// ===========================================================================

/** Index of a kind in `PRICING_RULE_KINDS`; used to order the breakdown. */
const kindIndex = (kind: PricingRuleKind): number => {
  const i = PRICING_RULE_KINDS.indexOf(kind);
  return i === -1 ? PRICING_RULE_KINDS.length : i;
};

/**
 * The total order two same-kind candidates are compared by: lower `priority`
 * first, then `id` ascending. Total (ids are unique) and independent of input
 * order, which is exactly what makes the outcome reproducible.
 */
const comparePrecedence = (a: DynamicPricingRule, b: DynamicPricingRule): number =>
  (a.priority ?? 0) - (b.priority ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Why a matching rule did not make it into the price. */
export type SuppressionReason = 'LESS_SPECIFIC_SCOPE' | 'LOWER_PRECEDENCE';

export interface SuppressedRule {
  ruleId: string;
  name: string;
  kind: PricingRuleKind;
  reason: SuppressionReason;
  /** The rule that beat it — the answer to "why didn't my rule apply?". */
  supersededByRuleId: string;
}

export interface RuleSelection {
  /** At most one rule per kind, ordered by `PRICING_RULE_KINDS`. */
  winners: DynamicPricingRule[];
  /** Rules that matched but lost, with the reason and the winner. */
  suppressed: SuppressedRule[];
}

/**
 * Stages B and C: from every candidate, pick the one rule per kind that applies,
 * and record why each loser lost. Pure; the result depends only on the SET of
 * rules, not on the order they arrive in.
 */
export const selectRules = (
  rules: readonly DynamicPricingRule[],
  ctx: PricingContext,
): RuleSelection => {
  const candidates = rules.filter((r) => isRuleCandidate(r, ctx));

  const byKind = new Map<PricingRuleKind, DynamicPricingRule[]>();
  for (const rule of candidates) {
    const list = byKind.get(rule.kind);
    if (list) list.push(rule);
    else byKind.set(rule.kind, [rule]);
  }

  const winners: DynamicPricingRule[] = [];
  const suppressed: SuppressedRule[] = [];

  for (const kind of PRICING_RULE_KINDS) {
    const group = byKind.get(kind);
    if (!group || group.length === 0) continue;

    // B — only the most specific scope tier present competes.
    const topTier = Math.max(...group.map(ruleScopeTier));
    const contenders = group.filter((r) => ruleScopeTier(r) === topTier);

    // C — lowest priority wins, ties broken by id.
    const ordered = [...contenders].sort(comparePrecedence);
    const winner = ordered[0]!;
    winners.push(winner);

    for (const loser of group) {
      if (loser === winner) continue;
      suppressed.push({
        ruleId: loser.id,
        name: loser.name ?? loser.id,
        kind,
        reason:
          ruleScopeTier(loser) < topTier ? 'LESS_SPECIFIC_SCOPE' : 'LOWER_PRECEDENCE',
        supersededByRuleId: winner.id,
      });
    }
  }

  // Stable, kind-ordered output so two callers with the same data render the
  // same breakdown. Suppressed rows follow the same order for the same reason.
  suppressed.sort(
    (a, b) =>
      kindIndex(a.kind) - kindIndex(b.kind) || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0),
  );

  return { winners, suppressed };
};

// ===========================================================================
// Composition — stage D
// ===========================================================================

/**
 * Common denominator every percentage is normalised onto: `percentToRational`
 * yields a denominator of `10^decimals * 100` with at most 4 decimals, so 1e6 is
 * divisible by all of them and the sum stays exact integer arithmetic.
 */
const PERCENT_DENOMINATOR = 1_000_000;

/** One rule's contribution to the final price, in whole cents. */
export interface AppliedRule {
  ruleId: string;
  name: string;
  kind: PricingRuleKind;
  adjustmentType: PricingAdjustmentType;
  adjustmentValue: number;
  /**
   * Cents this rule added (or removed). These sum EXACTLY to
   * `rawPriceCents - basePriceCents`, so a breakdown shown to an operator always
   * adds up — see the cumulative-rounding note in `resolveDynamicPrice`.
   */
  deltaCents: number;
}

export type ClampReason = 'NONE' | 'FLOOR' | 'CEILING';

export interface DynamicPriceResult {
  /** The rate's list price, echoed back so a caller can show "was / now". */
  basePriceCents: number;
  /** Total contribution of every PERCENT winner, rounded exactly once. */
  percentDeltaCents: number;
  /** Total contribution of every FLAT winner. */
  flatDeltaCents: number;
  /** base + percentDelta + flatDelta, BEFORE the guardrails. */
  rawPriceCents: number;
  /** The price to charge: `rawPriceCents` clamped into [floor, ceiling]. */
  priceCents: number;
  floorCents: number;
  ceilingCents: number;
  /** Which bound (if any) the raw price hit. `NONE` in the healthy case. */
  clampedBy: ClampReason;
  /** The winning rules, in `PRICING_RULE_KINDS` order, with their contributions. */
  applied: AppliedRule[];
  /** Rules that matched but were beaten, with the reason. Drives the admin's "why". */
  suppressed: SuppressedRule[];
}

/**
 * Sum a set of percentages exactly, as `numerator / PERCENT_DENOMINATOR` where
 * the value is a fraction of one (15% => 150_000 / 1_000_000). Floats never touch
 * the addition: `0.1 + 0.2` is not `0.3`, and a percentage stack is exactly the
 * place that error would land on a customer's card.
 */
const percentNumerator = (percent: number): number => {
  const { numerator, denominator } = percentToRational(percent);
  // `denominator` always divides PERCENT_DENOMINATOR (it is 10^k * 100, k <= 4).
  return numerator * (PERCENT_DENOMINATOR / denominator);
};

/** The floor/ceiling for a base price under the given guardrails. */
export const guardrailBounds = (
  basePriceCents: number,
  guardrails: PriceGuardrails = DEFAULT_PRICE_GUARDRAILS,
): { floorCents: number; ceilingCents: number } => {
  const base = Math.max(0, roundCents(basePriceCents));
  // A free line item has nothing to scale: a multiplier of a zero base is zero,
  // and letting a flat rule turn a $0 add-on into a charge is not a pricing rule,
  // it is a bug. Both bounds collapse to 0.
  if (base === 0) return { floorCents: 0, ceilingCents: 0 };

  const rawFloor = Math.max(
    Math.max(0, Math.trunc(guardrails.absoluteFloorCents)),
    roundCents(base * Math.max(0, guardrails.minMultiplier)),
  );
  const rawCeiling = roundCents(base * Math.max(0, guardrails.maxMultiplier));
  // A misconfigured pair (floor above ceiling) must still yield a usable range.
  // The floor is the guest-protective bound, so it wins and the ceiling opens up.
  return { floorCents: rawFloor, ceilingCents: Math.max(rawFloor, rawCeiling) };
};

/**
 * Resolve a rate's effective per-unit price for one slot. This is the function
 * everything else in the feature calls — booking, the quote endpoint, and the
 * admin preview all run this exact code path, which is why the preview can be
 * trusted.
 *
 * Deterministic: the same rule set and context always produce the same result,
 * whatever order the rules arrive in.
 */
export const resolveDynamicPrice = (
  basePriceCents: number,
  rules: readonly DynamicPricingRule[],
  ctx: PricingContext,
  guardrails: PriceGuardrails = DEFAULT_PRICE_GUARDRAILS,
): DynamicPriceResult => {
  const base = Math.max(0, roundCents(assertCents(Math.trunc(basePriceCents), 'basePriceCents')));
  const { winners, suppressed } = selectRules(rules, ctx);
  const { floorCents, ceilingCents } = guardrailBounds(base, guardrails);

  // Stage D. Percentages accumulate as exact rationals and FLAT amounts as whole
  // cents; the running *cumulative* delta is what gets rounded, and each rule's
  // reported delta is the difference between two cumulative roundings. That gives
  // the breakdown two properties an operator needs simultaneously: the total is
  // rounded exactly once (no compounding drift), and the rows still add up to it.
  let percentNum = 0;
  let flatDelta = 0;
  let previousCumulative = 0;
  const applied: AppliedRule[] = [];

  for (const rule of winners) {
    if (rule.adjustmentType === 'PERCENT') {
      percentNum += percentNumerator(rule.adjustmentValue);
    } else {
      flatDelta += Math.trunc(rule.adjustmentValue);
    }
    const cumulative = prorate(base, percentNum, PERCENT_DENOMINATOR) + flatDelta;
    applied.push({
      ruleId: rule.id,
      name: rule.name ?? rule.id,
      kind: rule.kind,
      adjustmentType: rule.adjustmentType,
      adjustmentValue: rule.adjustmentValue,
      deltaCents: cumulative - previousCumulative,
    });
    previousCumulative = cumulative;
  }

  const percentDeltaCents = prorate(base, percentNum, PERCENT_DENOMINATOR);
  const rawPriceCents = base + percentDeltaCents + flatDelta;

  // Stage E.
  let priceCents = rawPriceCents;
  let clampedBy: ClampReason = 'NONE';
  if (rawPriceCents < floorCents) {
    priceCents = floorCents;
    clampedBy = 'FLOOR';
  } else if (rawPriceCents > ceilingCents) {
    priceCents = ceilingCents;
    clampedBy = 'CEILING';
  }

  return {
    basePriceCents: base,
    percentDeltaCents,
    flatDeltaCents: flatDelta,
    rawPriceCents,
    priceCents,
    floorCents,
    ceilingCents,
    clampedBy,
    applied,
    suppressed,
  };
};

/** Human-readable summary of one applied rule, for the admin preview and receipts. */
export const describeAdjustment = (
  type: PricingAdjustmentType,
  value: number,
): string => {
  if (type === 'PERCENT') return `${value > 0 ? '+' : ''}${value}%`;
  const dollars = (Math.abs(value) / 100).toFixed(2);
  return `${value < 0 ? '-' : '+'}$${dollars}`;
};

// ===========================================================================
// Quote integrity — the quoted price is the charged price
// ===========================================================================

/** How long a signed quote is honoured after it is issued. */
export const PRICE_QUOTE_TTL_SECONDS = 15 * 60;

/**
 * Everything a quote is a promise about. Any change to any of these fields is a
 * different quote — which is the point: a client cannot swap the rate, the slot,
 * or the quantity and keep the price.
 */
export interface QuoteFingerprintInput {
  operatorId: string;
  activityId: string;
  rateId: string;
  timeslotId: string;
  quantity: number;
  /** The resolved per-unit price the guest was shown. */
  unitPriceCents: number;
  /** The rate's list price at quote time — proves which base the price came from. */
  basePriceCents: number;
  /** Ids of the rules that produced the price. Order-insensitive (sorted here). */
  ruleIds: readonly string[];
  /** Epoch milliseconds. */
  issuedAtMs: number;
  expiresAtMs: number;
}

/**
 * Canonical, stable string form of a quote — the exact bytes that get signed.
 *
 * Hand-built rather than `JSON.stringify(obj)` because object key order is an
 * implementation detail and a signature must not depend on one. Rule ids are
 * sorted for the same reason: the same rule set must fingerprint identically
 * whatever order the database returned it in.
 */
export const quoteFingerprint = (input: QuoteFingerprintInput): string =>
  [
    'v1',
    input.operatorId,
    input.activityId,
    input.rateId,
    input.timeslotId,
    String(Math.trunc(input.quantity)),
    String(Math.trunc(input.unitPriceCents)),
    String(Math.trunc(input.basePriceCents)),
    [...input.ruleIds].sort().join(','),
    String(Math.trunc(input.issuedAtMs)),
    String(Math.trunc(input.expiresAtMs)),
  ].join('|');

/**
 * What happened between quote and checkout.
 *
 *   - `MATCH`     — the live rules still produce the quoted price. The ordinary case.
 *   - `HONORED`   — they do not, but the quote is signed and unexpired, so the guest
 *                   pays what they were shown and the operator absorbs the delta.
 *   - `REPRICED`  — the quote is expired or unverifiable. The current price applies
 *                   and the guest MUST be shown it before anything is charged.
 */
export type QuoteStatus = 'MATCH' | 'HONORED' | 'REPRICED';

export interface QuoteReconciliation {
  status: QuoteStatus;
  /** The unit price to actually charge. */
  unitPriceCents: number;
  quotedUnitPriceCents: number;
  currentUnitPriceCents: number;
  /** current − quoted. Positive means the price went up after the quote. */
  deltaCents: number;
  /** True when the guest must re-confirm before being charged. */
  requiresGuestConfirmation: boolean;
}

/**
 * Decide what to charge. `signatureValid` and `expired` are computed by the
 * caller (the API holds the HMAC key; this module stays crypto-free so the admin
 * bundle can import it), and everything else about the decision lives here so it
 * is tested once and behaves identically everywhere.
 */
export const reconcileQuote = (input: {
  quotedUnitPriceCents: number;
  currentUnitPriceCents: number;
  signatureValid: boolean;
  expired: boolean;
}): QuoteReconciliation => {
  const quoted = Math.trunc(input.quotedUnitPriceCents);
  const current = Math.trunc(input.currentUnitPriceCents);
  const deltaCents = current - quoted;

  // An unsigned or expired quote is not a promise. Re-price and make the guest
  // look at the number again — never silently charge a price nobody displayed.
  if (!input.signatureValid || input.expired) {
    return {
      status: 'REPRICED',
      unitPriceCents: current,
      quotedUnitPriceCents: quoted,
      currentUnitPriceCents: current,
      deltaCents,
      requiresGuestConfirmation: deltaCents !== 0,
    };
  }

  if (deltaCents === 0) {
    return {
      status: 'MATCH',
      unitPriceCents: current,
      quotedUnitPriceCents: quoted,
      currentUnitPriceCents: current,
      deltaCents: 0,
      requiresGuestConfirmation: false,
    };
  }

  return {
    status: 'HONORED',
    unitPriceCents: quoted,
    quotedUnitPriceCents: quoted,
    currentUnitPriceCents: current,
    deltaCents,
    requiresGuestConfirmation: false,
  };
};
