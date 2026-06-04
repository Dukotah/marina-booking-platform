import { describe, expect, it } from 'vitest';
import {
  calculatePricing,
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
