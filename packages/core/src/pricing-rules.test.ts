import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICE_GUARDRAILS,
  PRICING_RULE_KINDS,
  guardrailBounds,
  isRuleCandidate,
  quoteFingerprint,
  reconcileQuote,
  resolveDynamicPrice,
  ruleMatches,
  selectRules,
  type DynamicPricingRule,
  type PricingContext,
} from './pricing-rules.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVITY = 'act_pontoon';
const RATE = 'rate_halfday';

/** Sat 4 Jul 2026, 17:30 local — a weekend, a holiday, and inside a sunset window. */
const JULY_4_SATURDAY_1730 = new Date(2026, 6, 4, 17, 30);
/** Tue 7 Jul 2026, 09:00 local — a plain summer weekday morning. */
const JULY_7_TUESDAY_0900 = new Date(2026, 6, 7, 9, 0);
/** Tue 14 Apr 2026, 09:00 local — off-season. */
const APRIL_14_TUESDAY_0900 = new Date(2026, 3, 14, 9, 0);

const baseCtx = (over: Partial<PricingContext> = {}): PricingContext => ({
  slotStart: JULY_4_SATURDAY_1730,
  activityId: ACTIVITY,
  rateId: RATE,
  ...over,
});

const rule = (over: Partial<DynamicPricingRule> & { id: string }): DynamicPricingRule => ({
  kind: 'SEASONAL',
  adjustmentType: 'PERCENT',
  adjustmentValue: 0,
  ...over,
});

/** Every ordering of a small array, so "order does not matter" can be proven, not asserted. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([items[i]!, ...tail]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching, one kind at a time
// ---------------------------------------------------------------------------

describe('ruleMatches — SEASONAL', () => {
  const summer = rule({
    id: 'r_summer',
    kind: 'SEASONAL',
    startsOn: new Date(2026, 5, 1),
    endsOn: new Date(2026, 8, 30),
  });

  it('fires inside the window', () => {
    expect(ruleMatches(summer, baseCtx())).toBe(true);
  });

  it('does not fire outside the window', () => {
    expect(ruleMatches(summer, baseCtx({ slotStart: APRIL_14_TUESDAY_0900 }))).toBe(false);
  });

  it('includes both endpoints, comparing calendar days not instants', () => {
    // 23:59 on the last day is still the last day.
    const lastDayLate = new Date(2026, 8, 30, 23, 59);
    const firstDayEarly = new Date(2026, 5, 1, 0, 1);
    expect(ruleMatches(summer, baseCtx({ slotStart: lastDayLate }))).toBe(true);
    expect(ruleMatches(summer, baseCtx({ slotStart: firstDayEarly }))).toBe(true);
  });

  it('treats a missing bound as open-ended', () => {
    const fromJune = rule({ id: 'r', kind: 'SEASONAL', startsOn: new Date(2026, 5, 1), endsOn: null });
    expect(ruleMatches(fromJune, baseCtx({ slotStart: new Date(2030, 0, 1) }))).toBe(true);
    expect(ruleMatches(fromJune, baseCtx({ slotStart: APRIL_14_TUESDAY_0900 }))).toBe(false);
  });
});

describe('ruleMatches — WEEKEND', () => {
  it('defaults to Saturday and Sunday when no weekdays are configured', () => {
    const weekend = rule({ id: 'r', kind: 'WEEKEND' });
    expect(ruleMatches(weekend, baseCtx())).toBe(true); // Saturday
    expect(ruleMatches(weekend, baseCtx({ slotStart: new Date(2026, 6, 5, 9, 0) }))).toBe(true); // Sunday
    expect(ruleMatches(weekend, baseCtx({ slotStart: JULY_7_TUESDAY_0900 }))).toBe(false);
  });

  it('honours an explicit weekday list (ISO 1=Mon..7=Sun)', () => {
    const tuesdays = rule({ id: 'r', kind: 'WEEKEND', weekdays: [2] });
    expect(ruleMatches(tuesdays, baseCtx({ slotStart: JULY_7_TUESDAY_0900 }))).toBe(true);
    expect(ruleMatches(tuesdays, baseCtx())).toBe(false);
  });
});

describe('ruleMatches — TIME_OF_DAY', () => {
  const sunset = rule({ id: 'r', kind: 'TIME_OF_DAY', startMinute: 17 * 60, endMinute: 20 * 60 });

  it('fires inside the window, inclusive of both ends', () => {
    expect(ruleMatches(sunset, baseCtx())).toBe(true); // 17:30
    expect(ruleMatches(sunset, baseCtx({ slotStart: new Date(2026, 6, 4, 17, 0) }))).toBe(true);
    expect(ruleMatches(sunset, baseCtx({ slotStart: new Date(2026, 6, 4, 20, 0) }))).toBe(true);
  });

  it('does not fire outside the window', () => {
    expect(ruleMatches(sunset, baseCtx({ slotStart: new Date(2026, 6, 4, 16, 59) }))).toBe(false);
    expect(ruleMatches(sunset, baseCtx({ slotStart: new Date(2026, 6, 4, 20, 1) }))).toBe(false);
  });

  it('wraps past midnight when the end is before the start', () => {
    const night = rule({ id: 'r', kind: 'TIME_OF_DAY', startMinute: 22 * 60, endMinute: 2 * 60 });
    expect(ruleMatches(night, baseCtx({ slotStart: new Date(2026, 6, 4, 23, 15) }))).toBe(true);
    expect(ruleMatches(night, baseCtx({ slotStart: new Date(2026, 6, 4, 1, 0) }))).toBe(true);
    expect(ruleMatches(night, baseCtx({ slotStart: new Date(2026, 6, 4, 12, 0) }))).toBe(false);
  });

  it('never fires when the window is not configured', () => {
    const broken = rule({ id: 'r', kind: 'TIME_OF_DAY', startMinute: null, endMinute: null });
    expect(ruleMatches(broken, baseCtx())).toBe(false);
  });
});

describe('ruleMatches — LEAD_TIME', () => {
  const now = new Date(2026, 6, 4, 12, 0); // 5.5h before the slot

  it('fires for a last-minute booking (max lead)', () => {
    const lastMinute = rule({ id: 'r', kind: 'LEAD_TIME', maxLeadMinutes: 24 * 60 });
    expect(ruleMatches(lastMinute, baseCtx({ now }))).toBe(true);
  });

  it('does not fire when the booking is further out than the max', () => {
    const lastMinute = rule({ id: 'r', kind: 'LEAD_TIME', maxLeadMinutes: 60 });
    expect(ruleMatches(lastMinute, baseCtx({ now }))).toBe(false);
  });

  it('fires for an early bird (min lead)', () => {
    const earlyBird = rule({ id: 'r', kind: 'LEAD_TIME', minLeadMinutes: 30 * 24 * 60 });
    const wayEarly = new Date(2026, 3, 1, 12, 0);
    expect(ruleMatches(earlyBird, baseCtx({ now: wayEarly }))).toBe(true);
    expect(ruleMatches(earlyBird, baseCtx({ now }))).toBe(false);
  });

  it('supports a bounded band (min and max together)', () => {
    const band = rule({ id: 'r', kind: 'LEAD_TIME', minLeadMinutes: 60, maxLeadMinutes: 480 });
    expect(ruleMatches(band, baseCtx({ now }))).toBe(true); // 330 minutes out
    expect(ruleMatches(band, baseCtx({ now: new Date(2026, 6, 4, 17, 15) }))).toBe(false); // 15 min
  });

  it('never fires without a clock, and never for a slot in the past', () => {
    const lastMinute = rule({ id: 'r', kind: 'LEAD_TIME', maxLeadMinutes: 24 * 60 });
    expect(ruleMatches(lastMinute, baseCtx())).toBe(false);
    const afterTheSlot = new Date(2026, 6, 5, 12, 0);
    const withMin = rule({ id: 'r', kind: 'LEAD_TIME', minLeadMinutes: 0, maxLeadMinutes: 24 * 60 });
    expect(ruleMatches(withMin, baseCtx({ now: afterTheSlot }))).toBe(false);
  });
});

describe('ruleMatches — DEMAND', () => {
  const nearlyFull = rule({ id: 'r', kind: 'DEMAND', demandThreshold: 0.8 });

  it('fires at and above the threshold', () => {
    expect(ruleMatches(nearlyFull, baseCtx({ bookedRatio: 0.8 }))).toBe(true);
    expect(ruleMatches(nearlyFull, baseCtx({ bookedRatio: 0.95 }))).toBe(true);
  });

  it('does not fire below the threshold', () => {
    expect(ruleMatches(nearlyFull, baseCtx({ bookedRatio: 0.79 }))).toBe(false);
  });

  it('never fires without a demand signal', () => {
    expect(ruleMatches(nearlyFull, baseCtx())).toBe(false);
  });
});

describe('ruleMatches — GUIDE_MARKUP', () => {
  it('is unconditional; the scope is the condition', () => {
    const guided = rule({ id: 'r', kind: 'GUIDE_MARKUP', rateId: RATE });
    expect(ruleMatches(guided, baseCtx())).toBe(true);
    expect(ruleMatches(guided, baseCtx({ slotStart: APRIL_14_TUESDAY_0900 }))).toBe(true);
  });
});

describe('candidacy', () => {
  it('excludes a disabled rule', () => {
    const off = rule({ id: 'r', kind: 'WEEKEND', isActive: false });
    expect(isRuleCandidate(off, baseCtx())).toBe(false);
  });

  it('excludes a rule scoped to a different activity or rate', () => {
    const otherActivity = rule({ id: 'r', kind: 'WEEKEND', activityId: 'act_other' });
    const otherRate = rule({ id: 'r2', kind: 'WEEKEND', rateId: 'rate_other' });
    expect(isRuleCandidate(otherActivity, baseCtx())).toBe(false);
    expect(isRuleCandidate(otherRate, baseCtx())).toBe(false);
  });

  it('cannot match a scoped rule when the context names nothing', () => {
    const scoped = rule({ id: 'r', kind: 'WEEKEND', activityId: ACTIVITY });
    const anonymous: PricingContext = { slotStart: JULY_4_SATURDAY_1730 };
    expect(isRuleCandidate(scoped, anonymous)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stage B/C — specificity and one-winner-per-kind
// ---------------------------------------------------------------------------

describe('selectRules — precedence', () => {
  it('keeps only the most specific scope tier within a kind', () => {
    const global = rule({ id: 'a_global', kind: 'WEEKEND', adjustmentValue: 10 });
    const byActivity = rule({ id: 'b_activity', kind: 'WEEKEND', activityId: ACTIVITY, adjustmentValue: 20 });
    const byRate = rule({ id: 'c_rate', kind: 'WEEKEND', rateId: RATE, adjustmentValue: 30 });

    const { winners, suppressed } = selectRules([global, byActivity, byRate], baseCtx());
    expect(winners.map((w) => w.id)).toEqual(['c_rate']);
    expect(suppressed).toEqual([
      {
        ruleId: 'a_global',
        name: 'a_global',
        kind: 'WEEKEND',
        reason: 'LESS_SPECIFIC_SCOPE',
        supersededByRuleId: 'c_rate',
      },
      {
        ruleId: 'b_activity',
        name: 'b_activity',
        kind: 'WEEKEND',
        reason: 'LESS_SPECIFIC_SCOPE',
        supersededByRuleId: 'c_rate',
      },
    ]);
  });

  it('picks exactly one winner per kind by lowest priority', () => {
    const july4 = rule({ id: 'r_july4', kind: 'SEASONAL', priority: 1, adjustmentValue: 30 });
    const summer = rule({ id: 'r_summer', kind: 'SEASONAL', priority: 5, adjustmentValue: 15 });
    const { winners, suppressed } = selectRules([summer, july4], baseCtx());
    expect(winners.map((w) => w.id)).toEqual(['r_july4']);
    expect(suppressed).toEqual([
      {
        ruleId: 'r_summer',
        name: 'r_summer',
        kind: 'SEASONAL',
        reason: 'LOWER_PRECEDENCE',
        supersededByRuleId: 'r_july4',
      },
    ]);
  });

  it('breaks a priority tie on id, not on input order', () => {
    const a = rule({ id: 'aaa', kind: 'SEASONAL', priority: 0, adjustmentValue: 5 });
    const b = rule({ id: 'bbb', kind: 'SEASONAL', priority: 0, adjustmentValue: 50 });
    expect(selectRules([a, b], baseCtx()).winners[0]!.id).toBe('aaa');
    expect(selectRules([b, a], baseCtx()).winners[0]!.id).toBe('aaa');
  });

  it('returns winners in the documented kind order regardless of input order', () => {
    const rules = [
      rule({ id: 'r_guide', kind: 'GUIDE_MARKUP', adjustmentValue: 5 }),
      rule({ id: 'r_demand', kind: 'DEMAND', demandThreshold: 0.5, adjustmentValue: 5 }),
      rule({ id: 'r_season', kind: 'SEASONAL', adjustmentValue: 5 }),
      rule({ id: 'r_weekend', kind: 'WEEKEND', adjustmentValue: 5 }),
    ];
    const { winners } = selectRules(rules, baseCtx({ bookedRatio: 0.9 }));
    const kinds = winners.map((w) => w.kind);
    const expectedOrder = PRICING_RULE_KINDS.filter((k) => kinds.includes(k));
    expect(kinds).toEqual(expectedOrder);
  });
});

// ---------------------------------------------------------------------------
// Stage D — composition, determinism, integer cents
// ---------------------------------------------------------------------------

describe('resolveDynamicPrice — determinism', () => {
  const rules = [
    rule({ id: 'r_season', kind: 'SEASONAL', adjustmentValue: 20, startsOn: new Date(2026, 5, 1), endsOn: new Date(2026, 8, 30) }),
    rule({ id: 'r_weekend', kind: 'WEEKEND', adjustmentValue: 15 }),
    rule({ id: 'r_sunset', kind: 'TIME_OF_DAY', adjustmentType: 'FLAT', adjustmentValue: 2500, startMinute: 17 * 60, endMinute: 20 * 60 }),
    rule({ id: 'r_demand', kind: 'DEMAND', adjustmentValue: 10, demandThreshold: 0.8 }),
  ];
  const ctx = baseCtx({ bookedRatio: 0.9 });

  it('gives the same price for every ordering of the same rule set', () => {
    const reference = resolveDynamicPrice(29_900, rules, ctx);
    for (const ordering of permutations(rules)) {
      const result = resolveDynamicPrice(29_900, ordering, ctx);
      expect(result.priceCents).toBe(reference.priceCents);
      expect(result.applied).toEqual(reference.applied);
      expect(result.suppressed).toEqual(reference.suppressed);
    }
  });

  it('stacks three matching rules against the base, not against each other', () => {
    // 20% + 15% + 10% = 45% of $299.00 = $134.55, plus the $25 sunset flat.
    const result = resolveDynamicPrice(29_900, rules, ctx);
    expect(result.percentDeltaCents).toBe(13_455);
    expect(result.flatDeltaCents).toBe(2_500);
    expect(result.rawPriceCents).toBe(29_900 + 13_455 + 2_500);
    expect(result.priceCents).toBe(45_855);
    expect(result.clampedBy).toBe('NONE');
  });
});

describe('resolveDynamicPrice — integer cents and rounding', () => {
  it('does not compound a percentage onto a percentage', () => {
    // Base $33.33. Compounding would give round(3333*1.1)=3666 then round(3666*1.1)=4033.
    // Base-anchored is a single 20% of 3333 = 666.6 -> 667, i.e. 4000.
    const rules = [
      rule({ id: 'r_a', kind: 'SEASONAL', adjustmentValue: 10 }),
      rule({ id: 'r_b', kind: 'WEEKEND', adjustmentValue: 10 }),
    ];
    const result = resolveDynamicPrice(3_333, rules, baseCtx());
    expect(result.percentDeltaCents).toBe(667);
    expect(result.priceCents).toBe(4_000);
  });

  it('rounds the whole percentage stack exactly once (half-up, no drift)', () => {
    // 3 x 5% of $1.01 is 15.15c exactly. Rounded once -> 15c.
    // Rounded per rule it would be 5c + 5c + 6c (compounded) and drift high.
    const rules = [
      rule({ id: 'r_a', kind: 'SEASONAL', adjustmentValue: 5 }),
      rule({ id: 'r_b', kind: 'WEEKEND', adjustmentValue: 5 }),
      rule({ id: 'r_c', kind: 'DEMAND', adjustmentValue: 5, demandThreshold: 0 }),
    ];
    const result = resolveDynamicPrice(101, rules, baseCtx({ bookedRatio: 1 }));
    expect(result.percentDeltaCents).toBe(15);
    expect(result.priceCents).toBe(116);
  });

  it('always returns whole cents', () => {
    const rules = [
      rule({ id: 'r_a', kind: 'SEASONAL', adjustmentValue: 7 }),
      rule({ id: 'r_b', kind: 'WEEKEND', adjustmentValue: 13 }),
      rule({ id: 'r_c', kind: 'TIME_OF_DAY', adjustmentType: 'FLAT', adjustmentValue: 333, startMinute: 0, endMinute: 1439 }),
    ];
    for (let base = 1; base <= 400; base++) {
      const result = resolveDynamicPrice(base, rules, baseCtx());
      expect(Number.isSafeInteger(result.priceCents)).toBe(true);
      expect(Number.isSafeInteger(result.percentDeltaCents)).toBe(true);
    }
  });

  it('reports per-rule deltas that sum exactly to the total adjustment', () => {
    const rules = [
      rule({ id: 'r_a', kind: 'SEASONAL', adjustmentValue: 5 }),
      rule({ id: 'r_b', kind: 'WEEKEND', adjustmentValue: 5 }),
      rule({ id: 'r_c', kind: 'DEMAND', adjustmentValue: 5, demandThreshold: 0 }),
      rule({ id: 'r_d', kind: 'GUIDE_MARKUP', adjustmentType: 'FLAT', adjustmentValue: 750 }),
    ];
    for (const base of [101, 999, 1_234, 29_900, 33_333]) {
      const result = resolveDynamicPrice(base, rules, baseCtx({ bookedRatio: 1 }));
      const summed = result.applied.reduce((s, a) => s + a.deltaCents, 0);
      expect(summed).toBe(result.rawPriceCents - result.basePriceCents);
    }
  });

  it('applies a negative percentage as a discount', () => {
    const lastMinute = rule({
      id: 'r_last',
      kind: 'LEAD_TIME',
      adjustmentValue: -20,
      maxLeadMinutes: 24 * 60,
    });
    const result = resolveDynamicPrice(
      10_000,
      [lastMinute],
      baseCtx({ now: new Date(2026, 6, 4, 12, 0) }),
    );
    expect(result.priceCents).toBe(8_000);
  });

  it('passes the base straight through when nothing matches', () => {
    const offSeason = rule({
      id: 'r',
      kind: 'SEASONAL',
      adjustmentValue: 50,
      startsOn: new Date(2026, 5, 1),
      endsOn: new Date(2026, 8, 30),
    });
    const result = resolveDynamicPrice(12_500, [offSeason], baseCtx({ slotStart: APRIL_14_TUESDAY_0900 }));
    expect(result.priceCents).toBe(12_500);
    expect(result.applied).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage E — the floor and the ceiling
// ---------------------------------------------------------------------------

describe('resolveDynamicPrice — guardrails', () => {
  it('never lets a stack of discounts go negative', () => {
    const rules = [
      rule({ id: 'r_a', kind: 'SEASONAL', adjustmentValue: -60 }),
      rule({ id: 'r_b', kind: 'WEEKEND', adjustmentValue: -60 }),
      rule({ id: 'r_c', kind: 'DEMAND', adjustmentType: 'FLAT', adjustmentValue: -50_000, demandThreshold: 0 }),
    ];
    const result = resolveDynamicPrice(10_000, rules, baseCtx({ bookedRatio: 1 }));
    expect(result.rawPriceCents).toBeLessThan(0);
    expect(result.priceCents).toBe(2_500); // 0.25 x base
    expect(result.clampedBy).toBe('FLOOR');
  });

  it('clamps an absurd markup at the ceiling', () => {
    const fatFinger = rule({ id: 'r', kind: 'DEMAND', adjustmentValue: 2000, demandThreshold: 0.5 });
    const result = resolveDynamicPrice(10_000, [fatFinger], baseCtx({ bookedRatio: 0.9 }));
    expect(result.rawPriceCents).toBe(210_000);
    expect(result.priceCents).toBe(30_000); // 3 x base
    expect(result.clampedBy).toBe('CEILING');
  });

  it('respects a caller-supplied guardrail set', () => {
    const half = rule({ id: 'r', kind: 'WEEKEND', adjustmentValue: -50 });
    const strict = { minMultiplier: 0.9, maxMultiplier: 1.1, absoluteFloorCents: 0 };
    const result = resolveDynamicPrice(10_000, [half], baseCtx(), strict);
    expect(result.priceCents).toBe(9_000);
    expect(result.clampedBy).toBe('FLOOR');
  });

  it('honours an absolute floor above the multiplier floor', () => {
    const deep = rule({ id: 'r', kind: 'WEEKEND', adjustmentValue: -90 });
    const withMinimum = { ...DEFAULT_PRICE_GUARDRAILS, absoluteFloorCents: 5_000 };
    const result = resolveDynamicPrice(10_000, [deep], baseCtx(), withMinimum);
    expect(result.floorCents).toBe(5_000);
    expect(result.priceCents).toBe(5_000);
  });

  it('collapses both bounds to zero for a free base price', () => {
    expect(guardrailBounds(0)).toEqual({ floorCents: 0, ceilingCents: 0 });
    const flat = rule({ id: 'r', kind: 'WEEKEND', adjustmentType: 'FLAT', adjustmentValue: 5_000 });
    expect(resolveDynamicPrice(0, [flat], baseCtx()).priceCents).toBe(0);
  });

  it('keeps a usable range when the guardrails are inverted', () => {
    const bounds = guardrailBounds(10_000, { minMultiplier: 2, maxMultiplier: 0.5, absoluteFloorCents: 0 });
    expect(bounds.floorCents).toBe(20_000);
    expect(bounds.ceilingCents).toBe(20_000);
  });
});

// ---------------------------------------------------------------------------
// The realistic marina scenario
// ---------------------------------------------------------------------------

describe('resolveDynamicPrice — Lake Sonoma pontoon, a July Saturday sunset', () => {
  const rules: DynamicPricingRule[] = [
    rule({ id: 'r_season', name: 'Summer season', kind: 'SEASONAL', adjustmentValue: 20, startsOn: new Date(2026, 4, 22), endsOn: new Date(2026, 8, 7) }),
    rule({ id: 'r_weekend', name: 'Weekend', kind: 'WEEKEND', adjustmentValue: 15 }),
    rule({ id: 'r_sunset', name: 'Sunset premium', kind: 'TIME_OF_DAY', adjustmentType: 'FLAT', adjustmentValue: 2_500, startMinute: 17 * 60, endMinute: 20 * 60 }),
    rule({ id: 'r_demand', name: 'Nearly full', kind: 'DEMAND', adjustmentValue: 10, demandThreshold: 0.8 }),
    rule({ id: 'r_earlybird', name: 'Early bird', kind: 'LEAD_TIME', adjustmentValue: -10, minLeadMinutes: 30 * 24 * 60 }),
  ];

  it('prices the peak slot up and names every rule that did it', () => {
    const result = resolveDynamicPrice(
      29_900,
      rules,
      baseCtx({ bookedRatio: 0.9, now: new Date(2026, 6, 4, 8, 0) }),
    );
    expect(result.applied.map((a) => a.name)).toEqual([
      'Summer season',
      'Weekend',
      'Sunset premium',
      'Nearly full',
    ]);
    expect(result.priceCents).toBe(45_855);
  });

  it('leaves a wet April Tuesday morning at the list price', () => {
    const result = resolveDynamicPrice(
      29_900,
      rules,
      baseCtx({ slotStart: APRIL_14_TUESDAY_0900, bookedRatio: 0.1, now: new Date(2026, 3, 13, 9, 0) }),
    );
    expect(result.applied).toEqual([]);
    expect(result.priceCents).toBe(29_900);
  });

  it('discounts an early-bird booking of the same off-season slot', () => {
    const result = resolveDynamicPrice(
      29_900,
      rules,
      baseCtx({ slotStart: APRIL_14_TUESDAY_0900, bookedRatio: 0.1, now: new Date(2026, 1, 1, 9, 0) }),
    );
    expect(result.applied.map((a) => a.name)).toEqual(['Early bird']);
    expect(result.priceCents).toBe(26_910);
  });
});

// ---------------------------------------------------------------------------
// Quote integrity
// ---------------------------------------------------------------------------

describe('quoteFingerprint', () => {
  const input = {
    operatorId: 'lsra',
    activityId: ACTIVITY,
    rateId: RATE,
    timeslotId: 'slot_1',
    quantity: 2,
    unitPriceCents: 45_855,
    basePriceCents: 29_900,
    ruleIds: ['r_weekend', 'r_season', 'r_demand'],
    issuedAtMs: 1_780_000_000_000,
    expiresAtMs: 1_780_000_900_000,
  };

  it('is stable across rule-id ordering', () => {
    const a = quoteFingerprint(input);
    const b = quoteFingerprint({ ...input, ruleIds: ['r_demand', 'r_season', 'r_weekend'] });
    expect(a).toBe(b);
  });

  it('changes when any priced fact changes', () => {
    const reference = quoteFingerprint(input);
    expect(quoteFingerprint({ ...input, unitPriceCents: 45_854 })).not.toBe(reference);
    expect(quoteFingerprint({ ...input, quantity: 3 })).not.toBe(reference);
    expect(quoteFingerprint({ ...input, timeslotId: 'slot_2' })).not.toBe(reference);
    expect(quoteFingerprint({ ...input, rateId: 'rate_other' })).not.toBe(reference);
    expect(quoteFingerprint({ ...input, operatorId: 'other' })).not.toBe(reference);
    expect(quoteFingerprint({ ...input, ruleIds: ['r_season'] })).not.toBe(reference);
    expect(quoteFingerprint({ ...input, expiresAtMs: input.expiresAtMs + 1 })).not.toBe(reference);
  });
});

describe('reconcileQuote', () => {
  it('charges the current price when nothing changed', () => {
    const r = reconcileQuote({
      quotedUnitPriceCents: 45_855,
      currentUnitPriceCents: 45_855,
      signatureValid: true,
      expired: false,
    });
    expect(r.status).toBe('MATCH');
    expect(r.unitPriceCents).toBe(45_855);
    expect(r.requiresGuestConfirmation).toBe(false);
  });

  it('honours the quoted price when a rule changed mid-checkout', () => {
    const r = reconcileQuote({
      quotedUnitPriceCents: 45_855,
      currentUnitPriceCents: 52_000,
      signatureValid: true,
      expired: false,
    });
    expect(r.status).toBe('HONORED');
    expect(r.unitPriceCents).toBe(45_855);
    expect(r.deltaCents).toBe(6_145);
    expect(r.requiresGuestConfirmation).toBe(false);
  });

  it('honours a quote that is now more expensive than the live price too', () => {
    // Symmetry matters: "we charge what we showed" is the promise in both
    // directions, and a guest who was quoted less than the current price should
    // not be re-priced upward either.
    const r = reconcileQuote({
      quotedUnitPriceCents: 45_855,
      currentUnitPriceCents: 40_000,
      signatureValid: true,
      expired: false,
    });
    expect(r.status).toBe('HONORED');
    expect(r.unitPriceCents).toBe(45_855);
  });

  it('re-prices an expired quote and makes the guest confirm', () => {
    const r = reconcileQuote({
      quotedUnitPriceCents: 45_855,
      currentUnitPriceCents: 52_000,
      signatureValid: true,
      expired: true,
    });
    expect(r.status).toBe('REPRICED');
    expect(r.unitPriceCents).toBe(52_000);
    expect(r.requiresGuestConfirmation).toBe(true);
  });

  it('refuses to trust an unsigned or tampered quote', () => {
    const r = reconcileQuote({
      quotedUnitPriceCents: 1,
      currentUnitPriceCents: 52_000,
      signatureValid: false,
      expired: false,
    });
    expect(r.status).toBe('REPRICED');
    expect(r.unitPriceCents).toBe(52_000);
    expect(r.requiresGuestConfirmation).toBe(true);
  });

  it('does not ask for confirmation when an expired quote still matches', () => {
    const r = reconcileQuote({
      quotedUnitPriceCents: 45_855,
      currentUnitPriceCents: 45_855,
      signatureValid: true,
      expired: true,
    });
    expect(r.status).toBe('REPRICED');
    expect(r.requiresGuestConfirmation).toBe(false);
  });
});
