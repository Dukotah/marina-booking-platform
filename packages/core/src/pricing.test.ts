import { describe, expect, it } from 'vitest';
import {
  applyMemberPrice,
  calculatePricing,
  computeDepositCents,
  resolveDepositPercent,
  resolveEffectivePrice,
  type PricingFee,
  type PricingItem,
} from './pricing.js';

const TAX_9_25: PricingFee = { name: 'Sales Tax', type: 'PERCENT', value: 9.25 };
const PROCESSING_4: PricingFee = {
  name: 'Card Processing',
  type: 'PERCENT',
  value: 4,
};

describe('calculatePricing — subtotal', () => {
  it('sums a single line item (unitPrice * quantity)', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 1250, quantity: 3 }],
      fees: [],
    });
    expect(result.subtotalCents).toBe(3750);
  });

  it('sums multiple line items', () => {
    const items: PricingItem[] = [
      { unitPriceCents: 1000, quantity: 2 },
      { unitPriceCents: 550, quantity: 1 },
      { unitPriceCents: 99, quantity: 4 },
    ];
    const result = calculatePricing({ items, fees: [] });
    expect(result.subtotalCents).toBe(2000 + 550 + 396);
  });

  it('treats an empty cart as zero subtotal and zero total', () => {
    const result = calculatePricing({ items: [], fees: [] });
    expect(result).toEqual({
      subtotalCents: 0,
      discountCents: 0,
      taxCents: 0,
      processingFeeCents: 0,
      tipCents: 0,
      totalCents: 0,
    });
  });

  it('truncates fractional quantities and clamps negative quantities to zero', () => {
    expect(
      calculatePricing({
        items: [{ unitPriceCents: 1000, quantity: 2.9 }],
        fees: [],
      }).subtotalCents,
    ).toBe(2000);
    expect(
      calculatePricing({
        items: [{ unitPriceCents: 1000, quantity: -5 }],
        fees: [],
      }).subtotalCents,
    ).toBe(0);
  });
});

describe('calculatePricing — discounts', () => {
  it('applies a PERCENT discount to the subtotal', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [],
      promo: { discountType: 'PERCENT', discountValue: 10 },
    });
    expect(result.discountCents).toBe(1000);
    expect(result.totalCents).toBe(9000);
  });

  it('applies a FLAT discount in cents', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [],
      promo: { discountType: 'FLAT', discountValue: 2500 },
    });
    expect(result.discountCents).toBe(2500);
    expect(result.totalCents).toBe(7500);
  });

  it('clamps a FLAT discount larger than the subtotal to the subtotal', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 5000, quantity: 1 }],
      fees: [],
      promo: { discountType: 'FLAT', discountValue: 999999 },
    });
    expect(result.discountCents).toBe(5000);
    expect(result.totalCents).toBe(0);
  });

  it('clamps a negative discount value to zero', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 5000, quantity: 1 }],
      fees: [],
      promo: { discountType: 'FLAT', discountValue: -1000 },
    });
    expect(result.discountCents).toBe(0);
    expect(result.totalCents).toBe(5000);
  });

  it('rounds a PERCENT discount half-up', () => {
    // 12345 * 10% = 1234.5 -> 1235
    const result = calculatePricing({
      items: [{ unitPriceCents: 12345, quantity: 1 }],
      fees: [],
      promo: { discountType: 'PERCENT', discountValue: 10 },
    });
    expect(result.discountCents).toBe(1235);
  });

  it('treats a null promo as no discount', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 5000, quantity: 1 }],
      fees: [],
      promo: null,
    });
    expect(result.discountCents).toBe(0);
  });
});

describe('calculatePricing — tax', () => {
  it('applies the PERCENT fee named "Tax" as the tax rate', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [TAX_9_25],
    });
    // round(10000 * 9.25%) = round(925) = 925
    expect(result.taxCents).toBe(925);
    expect(result.totalCents).toBe(10925);
  });

  it('rounds tax half-up (35000 @ 9.25% = 3237.5 -> 3238)', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 35000, quantity: 1 }],
      fees: [TAX_9_25],
    });
    expect(result.taxCents).toBe(3238);
  });

  it('taxes the post-discount base, not the raw subtotal', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [TAX_9_25],
      promo: { discountType: 'FLAT', discountValue: 2000 },
    });
    // taxable = 8000; tax = round(8000 * 9.25%) = round(740) = 740
    expect(result.taxCents).toBe(740);
  });

  it('applies no tax when taxExempt is true even with a Tax fee', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [TAX_9_25],
      taxExempt: true,
    });
    expect(result.taxCents).toBe(0);
    expect(result.totalCents).toBe(10000);
  });

  it('matches the tax fee case-insensitively', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [{ name: 'STATE TAX', type: 'PERCENT', value: 5 }],
    });
    expect(result.taxCents).toBe(500);
  });
});

describe('calculatePricing — processing fee', () => {
  it('computes the processing fee on (taxable + tax)', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [TAX_9_25, PROCESSING_4],
    });
    // taxable = 10000; tax = 925; processing = round(10925 * 4%) = round(437) = 437
    expect(result.processingFeeCents).toBe(437);
    expect(result.totalCents).toBe(10000 + 925 + 437);
  });

  it('charges processing on the taxable base when no tax applies', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [PROCESSING_4],
    });
    expect(result.taxCents).toBe(0);
    expect(result.processingFeeCents).toBe(400);
  });

  it('matches the processing fee case-insensitively', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [{ name: 'Online processing surcharge', type: 'PERCENT', value: 3 }],
    });
    expect(result.processingFeeCents).toBe(300);
  });

  it('does not charge processing on the tip', () => {
    const noTip = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [PROCESSING_4],
    });
    const withTip = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [PROCESSING_4],
      tipCents: 5000,
    });
    expect(withTip.processingFeeCents).toBe(noTip.processingFeeCents);
  });
});

describe('calculatePricing — tips', () => {
  it('adds the tip to the total without taxing or processing it', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [TAX_9_25, PROCESSING_4],
      tipCents: 1500,
    });
    expect(result.tipCents).toBe(1500);
    // base total (no tip) = 10000 + 925 + 437 = 11362; +tip 1500 = 12862
    expect(result.totalCents).toBe(11362 + 1500);
  });

  it('defaults the tip to zero when omitted', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [],
    });
    expect(result.tipCents).toBe(0);
  });

  it('clamps a negative tip to zero', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [],
      tipCents: -500,
    });
    expect(result.tipCents).toBe(0);
    expect(result.totalCents).toBe(10000);
  });
});

describe('calculatePricing — FLAT and generic PERCENT fees', () => {
  it('adds FLAT fees to the taxable base (so they are taxed and processed)', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [
        { name: 'Cleaning Fee', type: 'FLAT', value: 2000 },
        TAX_9_25,
      ],
    });
    // taxable = 10000 + 2000 = 12000; tax = round(12000 * 9.25%) = round(1110) = 1110
    expect(result.taxCents).toBe(1110);
    expect(result.totalCents).toBe(12000 + 1110);
  });

  it('treats a generic PERCENT fee as a surcharge on the discounted base', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 10000, quantity: 1 }],
      fees: [{ name: 'Resort Fee', type: 'PERCENT', value: 5 }],
    });
    // surcharge = round(10000 * 5%) = 500; taxable = 10500
    expect(result.totalCents).toBe(10500);
  });
});

describe('calculatePricing — LSRA 5-person pontoon (Half Day)', () => {
  it('produces the canonical breakdown', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 35000, quantity: 1 }],
      fees: [TAX_9_25, PROCESSING_4],
    });

    // subtotal = 35000
    // tax      = round(35000 * 9.25%) = round(3237.5) = 3238
    // proc     = round((35000 + 3238) * 4%) = round(1529.52) = 1530
    // total    = 35000 + 3238 + 1530 = 39768
    expect(result).toEqual({
      subtotalCents: 35000,
      discountCents: 0,
      taxCents: 3238,
      processingFeeCents: 1530,
      tipCents: 0,
      totalCents: 39768,
    });
  });

  it('honors a 10% promo on the pontoon end to end', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 35000, quantity: 1 }],
      fees: [TAX_9_25, PROCESSING_4],
      promo: { discountType: 'PERCENT', discountValue: 10 },
    });
    // discount = 3500; taxable = 31500
    // tax  = round(31500 * 9.25%) = round(2913.75) = 2914
    // proc = round((31500 + 2914) * 4%) = round(1376.56) = 1377
    // total = 31500 + 2914 + 1377 = 35791
    expect(result).toEqual({
      subtotalCents: 35000,
      discountCents: 3500,
      taxCents: 2914,
      processingFeeCents: 1377,
      tipCents: 0,
      totalCents: 35791,
    });
  });
});

describe('calculatePricing — rounding edge cases', () => {
  it('rounds 0.5-cent boundaries up (half-up)', () => {
    // 1 unit @ 50c, 1% tax => 0.5c -> 1c
    const result = calculatePricing({
      items: [{ unitPriceCents: 50, quantity: 1 }],
      fees: [{ name: 'Tax', type: 'PERCENT', value: 1 }],
    });
    expect(result.taxCents).toBe(1);
  });

  it('keeps every output an integer number of cents', () => {
    const result = calculatePricing({
      items: [
        { unitPriceCents: 1337, quantity: 7 },
        { unitPriceCents: 89, quantity: 13 },
      ],
      fees: [
        { name: 'Sales Tax', type: 'PERCENT', value: 8.375 },
        { name: 'Processing', type: 'PERCENT', value: 2.9 },
        { name: 'Dock Fee', type: 'FLAT', value: 333 },
      ],
      promo: { discountType: 'PERCENT', discountValue: 7 },
      tipCents: 451,
    });
    for (const value of Object.values(result)) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('is internally consistent: total = taxable + tax + processing + tip', () => {
    const result = calculatePricing({
      items: [{ unitPriceCents: 9999, quantity: 3 }],
      fees: [
        { name: 'Tax', type: 'PERCENT', value: 7.25 },
        { name: 'Processing', type: 'PERCENT', value: 3.5 },
        { name: 'Fuel Fee', type: 'FLAT', value: 1500 },
      ],
      promo: { discountType: 'PERCENT', discountValue: 15 },
      tipCents: 800,
    });

    const taxable =
      result.subtotalCents - result.discountCents + 1500;
    expect(result.totalCents).toBe(
      taxable + result.taxCents + result.processingFeeCents + result.tipCents,
    );
  });
});

describe('resolveDepositPercent', () => {
  it('prefers the activity percent when set', () => {
    expect(resolveDepositPercent(30, 50)).toBe(30);
  });

  it('falls back to the operator default when the activity is null/0', () => {
    expect(resolveDepositPercent(null, 25)).toBe(25);
    expect(resolveDepositPercent(0, 25)).toBe(25);
    expect(resolveDepositPercent(undefined, 25)).toBe(25);
  });

  it('returns 0 (pay in full) when neither is set', () => {
    expect(resolveDepositPercent(null, null)).toBe(0);
    expect(resolveDepositPercent(0, 0)).toBe(0);
    expect(resolveDepositPercent(undefined, undefined)).toBe(0);
  });

  it('clamps to 1..99 and truncates fractions', () => {
    expect(resolveDepositPercent(150, null)).toBe(99);
    expect(resolveDepositPercent(33.9, null)).toBe(33);
  });
});

describe('computeDepositCents', () => {
  it('returns the given percentage of the total (rounded)', () => {
    expect(computeDepositCents(10000, 30)).toBe(3000);
    expect(computeDepositCents(9999, 50)).toBe(5000); // 4999.5 -> 5000 (half-up)
  });

  it('returns the full total when no deposit applies (percent 0 or >=100)', () => {
    expect(computeDepositCents(10000, 0)).toBe(10000);
    expect(computeDepositCents(10000, 100)).toBe(10000);
  });

  it('never exceeds the total and is at least 1c for a positive total+percent', () => {
    expect(computeDepositCents(50, 1)).toBe(1); // 0.5 -> 1 (rounded), floored at 1
    expect(computeDepositCents(10, 99)).toBe(10); // 9.9 -> 10, capped at total
  });

  it('is 0 for a zero total', () => {
    expect(computeDepositCents(0, 30)).toBe(0);
  });

  it('splits total into deposit + balance that always sums back to total', () => {
    const total = 12345;
    const deposit = computeDepositCents(total, 40);
    expect(deposit).toBe(4938); // 4938 (round of 4938)
    expect(total - deposit).toBe(7407);
    expect(deposit + (total - deposit)).toBe(total);
  });
});

// ===========================================================================
// Member pricing (Upmarket §1 #6-A)
// ===========================================================================

describe('applyMemberPrice', () => {
  it('applies a percent-off member discount, rounded to cents', () => {
    // 10000c base, 15% off => 8500c
    expect(applyMemberPrice(10000, { discountType: 'PERCENT', discountValue: 15 })).toBe(8500);
  });

  it('applies a flat cents-off member discount', () => {
    expect(applyMemberPrice(10000, { discountType: 'FLAT', discountValue: 500 })).toBe(9500);
  });

  it('is a no-op for a null / zero-value membership', () => {
    expect(applyMemberPrice(10000, null)).toBe(10000);
    expect(applyMemberPrice(10000, { discountType: 'PERCENT', discountValue: 0 })).toBe(10000);
  });

  it('never produces a negative price when a flat discount exceeds the base', () => {
    expect(applyMemberPrice(300, { discountType: 'FLAT', discountValue: 500 })).toBe(0);
  });

  it('clamps a >100% percent discount to a zero floor', () => {
    expect(applyMemberPrice(5000, { discountType: 'PERCENT', discountValue: 150 })).toBe(0);
  });
});

// ===========================================================================
// Dynamic pricing rules (Upmarket §1 #6-C)
// ===========================================================================

describe('resolveEffectivePrice', () => {
  const SAT = new Date(2026, 6, 11); // 2026-07-11 is a Saturday
  const WED = new Date(2026, 6, 8); // 2026-07-08 is a Wednesday

  it('passes the base price through unchanged when no rules apply', () => {
    const r = resolveEffectivePrice(10000, [], { date: WED });
    expect(r.priceCents).toBe(10000);
    expect(r.applied).toHaveLength(0);
  });

  it('applies a weekend percent markup on Saturday but not Wednesday', () => {
    const rule = {
      kind: 'WEEKEND' as const,
      adjustmentType: 'PERCENT' as const,
      adjustmentValue: 20,
    };
    expect(resolveEffectivePrice(10000, [rule], { date: SAT }).priceCents).toBe(12000);
    expect(resolveEffectivePrice(10000, [rule], { date: WED }).priceCents).toBe(10000);
  });

  it('honors a seasonal window (inclusive) by calendar date', () => {
    const rule = {
      kind: 'SEASONAL' as const,
      adjustmentType: 'FLAT' as const,
      adjustmentValue: 1000,
      startsOn: new Date(2026, 6, 1),
      endsOn: new Date(2026, 6, 31),
    };
    expect(resolveEffectivePrice(10000, [rule], { date: WED }).priceCents).toBe(11000);
    // Outside the window: no change.
    expect(
      resolveEffectivePrice(10000, [rule], { date: new Date(2026, 7, 5) }).priceCents,
    ).toBe(10000);
  });

  it('fires a demand rule only when booked ratio crosses the threshold', () => {
    const rule = {
      kind: 'DEMAND' as const,
      adjustmentType: 'PERCENT' as const,
      adjustmentValue: 10,
      demandThreshold: 0.8,
    };
    expect(resolveEffectivePrice(10000, [rule], { date: WED, bookedRatio: 0.9 }).priceCents).toBe(11000);
    expect(resolveEffectivePrice(10000, [rule], { date: WED, bookedRatio: 0.5 }).priceCents).toBe(10000);
    // No demand signal => never fires.
    expect(resolveEffectivePrice(10000, [rule], { date: WED }).priceCents).toBe(10000);
  });

  it('composes multiple rules in priority order over the running price', () => {
    // priority 0: +20% weekend (10000 -> 12000); priority 1: +$5 guide markup (12000 -> 12500).
    const rules = [
      {
        kind: 'GUIDE_MARKUP' as const,
        adjustmentType: 'FLAT' as const,
        adjustmentValue: 500,
        priority: 1,
      },
      {
        kind: 'WEEKEND' as const,
        adjustmentType: 'PERCENT' as const,
        adjustmentValue: 20,
        priority: 0,
      },
    ];
    const r = resolveEffectivePrice(10000, rules, { date: SAT });
    expect(r.priceCents).toBe(12500);
    expect(r.applied.map((a) => a.kind)).toEqual(['WEEKEND', 'GUIDE_MARKUP']);
  });

  it('skips inactive rules', () => {
    const rule = {
      kind: 'WEEKEND' as const,
      adjustmentType: 'PERCENT' as const,
      adjustmentValue: 50,
      isActive: false,
    };
    expect(resolveEffectivePrice(10000, [rule], { date: SAT }).priceCents).toBe(10000);
  });

  it('layers member pricing on top of dynamic pricing (weekend then member 15% off)', () => {
    const weekend = resolveEffectivePrice(
      10000,
      [{ kind: 'WEEKEND' as const, adjustmentType: 'PERCENT' as const, adjustmentValue: 20 }],
      { date: SAT },
    );
    expect(weekend.priceCents).toBe(12000);
    const member = applyMemberPrice(weekend.priceCents, {
      discountType: 'PERCENT',
      discountValue: 15,
    });
    expect(member).toBe(10200); // 12000 - 15%
  });
});
