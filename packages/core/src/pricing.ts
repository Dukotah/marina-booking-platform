/**
 * Pricing engine — this governs real money, so it is intentionally explicit and
 * deterministic. Everything is computed in INTEGER CENTS.
 *
 * Order of operations (must match the platform-wide contract):
 *   1. subtotal      = sum(unitPriceCents * quantity)
 *   2. discount      = applied to the subtotal (PERCENT or FLAT), never below 0
 *   3. FLAT fees     = added to the taxable base
 *   4. taxable       = subtotal - discount + sum(FLAT fees)
 *   5. tax           = round(taxable * taxPct)   (0 when taxExempt)
 *   6. processingFee = round((taxable + tax) * procPct)
 *   7. total         = taxable + tax + processingFee + tip
 *
 * Fee classification:
 *   - The PERCENT fee whose name includes "Tax" (case-insensitive) is the tax rate.
 *   - The PERCENT fee whose name includes "Processing" is the processing rate.
 *   - Any other PERCENT fee is treated as a surcharge on the taxable base
 *     (percentage of subtotal-after-discount), added to the taxable base.
 *   - FLAT fees are added directly to the taxable base.
 */
import { roundCents } from './money.js';

export interface PricingItem {
  /** Price per single unit, in integer cents. */
  unitPriceCents: number;
  /** How many units. */
  quantity: number;
}

export interface PricingFee {
  /** Display name. "Tax"/"Processing" substrings drive special handling. */
  name: string;
  /** PERCENT fees use `value` as a percentage (e.g. 8.5 => 8.5%). FLAT fees use `value` as integer cents. */
  type: 'PERCENT' | 'FLAT';
  /** For PERCENT: a percentage (8.5 = 8.5%). For FLAT: integer cents. */
  value: number;
}

export interface PricingPromo {
  discountType: 'PERCENT' | 'FLAT';
  /** For PERCENT: a percentage (10 = 10%). For FLAT: integer cents off. */
  discountValue: number;
}

export interface PricingInput {
  items: PricingItem[];
  fees: PricingFee[];
  promo?: PricingPromo | null;
  /** Tip in integer cents. Not discounted, not taxed, not subject to processing fees. */
  tipCents?: number;
  /** When true, no tax is applied regardless of a configured Tax fee. */
  taxExempt?: boolean;
}

export interface PricingResult {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  processingFeeCents: number;
  tipCents: number;
  totalCents: number;
}

/**
 * Resolve the effective deposit percentage for a booking: the activity's own
 * `deposit_percent` when set, otherwise the operator default. A null/undefined/0
 * value at either level means "no deposit" (pay in full). Deterministic and pure.
 *
 * @returns an integer percentage clamped to 1..99, or 0 when no deposit applies.
 */
export const resolveDepositPercent = (
  activityPercent: number | null | undefined,
  operatorDefaultPercent: number | null | undefined,
): number => {
  const raw =
    activityPercent != null && activityPercent > 0 ? activityPercent : operatorDefaultPercent;
  if (raw == null || raw <= 0) return 0;
  return Math.min(99, Math.max(1, Math.trunc(raw)));
};

/**
 * The deposit due now for a given order total and deposit percentage, in integer
 * cents. A 0 (or out-of-range) percentage means the full total is due now, so the
 * caller can treat "no deposit" and "deposit" uniformly. The deposit is always at
 * least 1 cent (when a percent applies) and never exceeds the total.
 */
export const computeDepositCents = (totalCents: number, depositPercent: number): number => {
  const total = Math.max(0, roundCents(totalCents));
  if (!Number.isFinite(depositPercent) || depositPercent <= 0 || depositPercent >= 100) {
    // No deposit (or a nonsensical percent) => the whole total is due now.
    return total;
  }
  if (total === 0) return 0;
  const deposit = roundCents((total * depositPercent) / 100);
  // Guard the edges: a positive total with a positive percent always owes >= 1c,
  // and the deposit can never exceed the total.
  return Math.min(total, Math.max(1, deposit));
};

// ===========================================================================
// Member pricing (Upmarket §1 #6-A)
// ===========================================================================

/**
 * A member-pricing spec, mirroring the Membership discount knob. PERCENT is a
 * percent OFF the base price (15 => 15% off); FLAT is integer cents OFF the base.
 * A membership the customer does NOT hold is expressed as `null` by the caller.
 */
export interface MemberDiscount {
  discountType: 'PERCENT' | 'FLAT';
  /** PERCENT: a percentage off (15 = 15% off). FLAT: integer cents off. */
  discountValue: number;
}

/**
 * Apply a member discount to a single unit's base price, in integer cents.
 * Deterministic and pure; the result is clamped to [0, base] so member pricing
 * can never produce a negative price or (via a bad FLAT) exceed the base. A
 * null/undefined membership is a clean no-op (returns the base unchanged).
 */
export const applyMemberPrice = (
  basePriceCents: number,
  member: MemberDiscount | null | undefined,
): number => {
  const base = Math.max(0, roundCents(basePriceCents));
  if (!member || !Number.isFinite(member.discountValue) || member.discountValue <= 0) {
    return base;
  }
  const off =
    member.discountType === 'PERCENT'
      ? roundCents((base * member.discountValue) / 100)
      : roundCents(member.discountValue);
  return Math.min(base, Math.max(0, base - off));
};

// ===========================================================================
// Dynamic pricing rules (Upmarket §1 #6-C)
// ===========================================================================

/** Which weekdays a WEEKEND rule fires on when none are configured: Sat + Sun. */
const DEFAULT_WEEKEND: readonly number[] = [6, 7]; // ISO 6=Sat, 7=Sun

/**
 * A single composable pricing rule, decoupled from Prisma so it is unit-testable.
 * Mirrors the PricingRule model. Only the fields relevant to a given `kind` are
 * consulted, so callers can pass the whole row.
 */
export interface PricingRuleSpec {
  kind: 'SEASONAL' | 'WEEKEND' | 'DEMAND' | 'GUIDE_MARKUP';
  adjustmentType: 'PERCENT' | 'FLAT';
  /** PERCENT: percentage delta (+15 / -10). FLAT: integer cents delta (can be < 0). */
  adjustmentValue: number;
  /** Lower runs first. Ties are the caller's responsibility (e.g. by created_at). */
  priority?: number;
  isActive?: boolean;
  // SEASONAL window (inclusive). Compared by calendar date, not time-of-day.
  startsOn?: Date | null;
  endsOn?: Date | null;
  // WEEKEND: ISO weekdays (1=Mon..7=Sun). Empty => Sat+Sun.
  weekdays?: number[];
  // DEMAND: fire when bookedRatio >= threshold (0..1).
  demandThreshold?: number | null;
}

/** The evaluation context a rule set is resolved against for one slot/date. */
export interface PricingRuleContext {
  /** The slot's start date (used for SEASONAL window + WEEKEND weekday checks). */
  date: Date;
  /**
   * The slot's current booked ratio in 0..1 (booked / total), for DEMAND rules.
   * Omit/undefined => DEMAND rules never fire (no demand signal available).
   */
  bookedRatio?: number;
}

/** ISO weekday (1=Mon .. 7=Sun) for a date, from its local day-of-week. */
const isoWeekday = (d: Date): number => {
  const dow = d.getDay(); // 0=Sun..6=Sat
  return dow === 0 ? 7 : dow;
};

/** Whole calendar day (ms) for date-only comparisons, ignoring time-of-day. */
const dayFloor = (d: Date): number =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Is this rule active for the given context? Pure and side-effect-free. */
export const isRuleActive = (rule: PricingRuleSpec, ctx: PricingRuleContext): boolean => {
  if (rule.isActive === false) return false;
  switch (rule.kind) {
    case 'SEASONAL': {
      const day = dayFloor(ctx.date);
      if (rule.startsOn && day < dayFloor(rule.startsOn)) return false;
      if (rule.endsOn && day > dayFloor(rule.endsOn)) return false;
      return true;
    }
    case 'WEEKEND': {
      const days = rule.weekdays && rule.weekdays.length > 0 ? rule.weekdays : DEFAULT_WEEKEND;
      return days.includes(isoWeekday(ctx.date));
    }
    case 'DEMAND': {
      const threshold = rule.demandThreshold;
      if (threshold == null || ctx.bookedRatio == null) return false;
      return ctx.bookedRatio >= threshold;
    }
    case 'GUIDE_MARKUP':
      // Always-on surcharge when enabled; scoping (which rates) is the caller's job.
      return true;
    default:
      return false;
  }
};

/** Apply one adjustment to a running price (integer cents), clamped at >= 0. */
const applyAdjustment = (priceCents: number, rule: PricingRuleSpec): number => {
  const delta =
    rule.adjustmentType === 'PERCENT'
      ? roundCents((priceCents * rule.adjustmentValue) / 100)
      : roundCents(rule.adjustmentValue);
  return Math.max(0, priceCents + delta);
};

export interface EffectivePriceResult {
  /** The final per-unit price after every applicable rule, integer cents. */
  priceCents: number;
  /** The rules that fired, in application order, with the running price after each. */
  applied: Array<{ kind: PricingRuleSpec['kind']; deltaCents: number; priceCents: number }>;
}

/**
 * Resolve a rate's EFFECTIVE per-unit price for one slot/date by composing every
 * active dynamic pricing rule over the base price, in `priority` order (lower
 * first; stable for equal priorities). Each rule adjusts the RUNNING price, so a
 * +10% weekend rule and a +$5 demand rule stack predictably. Pure and
 * deterministic — no DB, no clock beyond the passed `ctx.date`.
 *
 * Composes cleanly with `calculatePricing`: feed the returned `priceCents` in as
 * the line item's `unitPriceCents`.
 */
export const resolveEffectivePrice = (
  basePriceCents: number,
  rules: readonly PricingRuleSpec[],
  ctx: PricingRuleContext,
): EffectivePriceResult => {
  let price = Math.max(0, roundCents(basePriceCents));
  const applied: EffectivePriceResult['applied'] = [];

  const ordered = [...rules]
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.priority ?? 0) - (b.r.priority ?? 0) || a.i - b.i)
    .map((x) => x.r);

  for (const rule of ordered) {
    if (!isRuleActive(rule, ctx)) continue;
    const next = applyAdjustment(price, rule);
    if (next !== price) {
      applied.push({ kind: rule.kind, deltaCents: next - price, priceCents: next });
      price = next;
    }
  }

  return { priceCents: price, applied };
};

const isTaxFee = (f: PricingFee): boolean =>
  f.type === 'PERCENT' && /tax/i.test(f.name);

const isProcessingFee = (f: PricingFee): boolean =>
  f.type === 'PERCENT' && /processing/i.test(f.name);

/**
 * Compute a complete, rounded price breakdown for a cart. Pure and deterministic.
 */
export const calculatePricing = (input: PricingInput): PricingResult => {
  const { items, fees, promo, taxExempt = false } = input;
  const tipCents = Math.max(0, roundCents(input.tipCents ?? 0));

  // 1. Subtotal — sum of line items (integer cents in, integer cents out).
  const subtotalCents = items.reduce(
    (sum, item) =>
      sum + roundCents(item.unitPriceCents) * Math.max(0, Math.trunc(item.quantity)),
    0,
  );

  // 2. Discount on subtotal, clamped to [0, subtotal].
  let discountCents = 0;
  if (promo) {
    if (promo.discountType === 'PERCENT') {
      discountCents = roundCents((subtotalCents * promo.discountValue) / 100);
    } else {
      discountCents = roundCents(promo.discountValue);
    }
  }
  discountCents = Math.min(Math.max(0, discountCents), subtotalCents);

  // Base that discounts, FLAT fees, and percentage surcharges apply to.
  const discountedBase = subtotalCents - discountCents;

  // 3 + 4. FLAT fees and non-tax/non-processing PERCENT surcharges feed the taxable base.
  let extraTaxableCents = 0;
  let taxPct = 0;
  let procPct = 0;

  for (const fee of fees) {
    if (isTaxFee(fee)) {
      // Last Tax fee wins if multiple are (mis)configured; first found is fine too.
      taxPct = fee.value;
      continue;
    }
    if (isProcessingFee(fee)) {
      procPct = fee.value;
      continue;
    }
    if (fee.type === 'FLAT') {
      extraTaxableCents += roundCents(fee.value);
    } else {
      // Generic percentage surcharge on the discounted base.
      extraTaxableCents += roundCents((discountedBase * fee.value) / 100);
    }
  }

  const taxableCents = discountedBase + extraTaxableCents;

  // 5. Tax.
  const taxCents = taxExempt ? 0 : roundCents((taxableCents * taxPct) / 100);

  // 6. Processing fee on (taxable + tax).
  const processingFeeCents = roundCents(((taxableCents + taxCents) * procPct) / 100);

  // 7. Total.
  const totalCents = taxableCents + taxCents + processingFeeCents + tipCents;

  return {
    subtotalCents,
    discountCents,
    taxCents,
    processingFeeCents,
    tipCents,
    totalCents,
  };
};
