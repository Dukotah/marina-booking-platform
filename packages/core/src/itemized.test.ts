import { describe, expect, it } from 'vitest';
import {
  allocateProportionally,
  buildItemizedSales,
  buildMerchandiseReport,
  type ItemizedInput,
} from './itemized.js';

describe('allocateProportionally', () => {
  it('splits exactly with no lost cents (largest remainder)', () => {
    const parts = allocateProportionally(100, [1, 1, 1]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it('is proportional to weights', () => {
    expect(allocateProportionally(300, [200, 100])).toEqual([200, 100]);
  });

  it('handles zero weights by assigning everything to the first slot', () => {
    expect(allocateProportionally(55, [0, 0])).toEqual([55, 0]);
  });

  it('handles empty weights and zero totals', () => {
    expect(allocateProportionally(10, [])).toEqual([]);
    expect(allocateProportionally(0, [5, 5])).toEqual([0, 0]);
  });

  it('allocates negative totals symmetrically', () => {
    const parts = allocateProportionally(-100, [1, 1, 1]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(-100);
    expect(parts.every((p) => p <= 0)).toBe(true);
  });
});

/** A two-order fixture: booking + add-on + merch + misc + package + charge. */
function fixture(): ItemizedInput {
  return {
    orders: [
      {
        id: 'o1',
        order_number: 'LS-1001',
        date: '2026-09-01',
        // 2 seats @ 15000 + addon 2500 + merch 2*600 + misc 5000 = 38700
        subtotal_cents: 38700,
        discount_cents: 3870, // 10%
        tax_cents: 2612, // 7.5% of net
        processing_fee_cents: 1045, // 3% of net
        tip_cents: 500,
        total_cents: 38700 - 3870 + 2612 + 1045 + 500 + 2500, // + fuel charge
      },
      {
        id: 'o2',
        order_number: 'LS-1002',
        date: '2026-09-02',
        // package: 2 lines summing to 20000
        subtotal_cents: 20000,
        discount_cents: 0,
        tax_cents: 1500,
        processing_fee_cents: 600,
        tip_cents: 0,
        total_cents: 22100,
      },
    ],
    activityLines: [
      {
        order_id: 'o1',
        activity_id: 'a1',
        activity_name: 'Pontoon Rental',
        rate_name: 'Full Day',
        quantity: 2,
        unit_price_cents: 15000,
        add_on_id: null,
        add_on_name: null,
        package_id: null,
        package_name: null,
      },
      {
        order_id: 'o1',
        activity_id: 'a1',
        activity_name: 'Pontoon Rental',
        rate_name: 'Full Day',
        quantity: 1,
        unit_price_cents: 2500,
        add_on_id: 'up1',
        add_on_name: 'Cooler + Ice',
        package_id: null,
        package_name: null,
      },
      {
        order_id: 'o2',
        activity_id: 'a1',
        activity_name: 'Pontoon Rental',
        rate_name: 'Half Day',
        quantity: 1,
        unit_price_cents: 12000,
        add_on_id: null,
        add_on_name: null,
        package_id: 'pkg1',
        package_name: 'Lake Day Bundle',
      },
      {
        order_id: 'o2',
        activity_id: 'a2',
        activity_name: 'Kayak',
        rate_name: 'Half Day',
        quantity: 2,
        unit_price_cents: 4000,
        add_on_id: null,
        add_on_name: null,
        package_id: 'pkg1',
        package_name: 'Lake Day Bundle',
      },
    ],
    merchLines: [
      {
        order_id: 'o1',
        kind: 'MERCHANDISE',
        name: 'Fuel',
        category: 'Fuel',
        variant: '1/4 gallon',
        quantity: 2,
        unit_price_cents: 600,
      },
      {
        order_id: 'o1',
        kind: 'MISC',
        name: '$50 Gift Card',
        category: 'Uncategorized',
        variant: null,
        quantity: 1,
        unit_price_cents: 5000,
      },
    ],
    charges: [{ order_id: 'o1', category: 'FUEL', label: 'Fuel — half tank', amount_cents: 2500 }],
  };
}

describe('buildItemizedSales', () => {
  it('groups lines and reconciles exactly with the order-level summary', () => {
    const result = buildItemizedSales(fixture());

    expect(result.reconciliation.ok).toBe(true);

    const keys = result.groups.map((g) => g.key);
    expect(keys).toEqual(['activity', 'packages', 'merchandise', 'charges']);

    // Grand total = Σ order.total_cents.
    const grossFromOrders = fixture().orders.reduce((s, o) => s + o.total_cents, 0);
    expect(result.grandTotalCents).toBe(grossFromOrders);

    // Group gross values cover the subtotals: activities + packages + merch.
    const byKey = Object.fromEntries(result.groups.map((g) => [g.key, g.totals]));
    expect(byKey.activity!.grossCents).toBe(30000);
    expect(byKey.packages!.grossCents).toBe(20000);
    expect(byKey.merchandise!.grossCents).toBe(2500 + 1200 + 5000); // addon + fuel + misc
    expect(byKey.charges!.grossCents).toBe(2500);

    // Discount allocation sums exactly to the order discounts.
    const totalDiscount = result.groups.reduce((s, g) => s + g.totals.discountCents, 0);
    expect(totalDiscount).toBe(3870);
    // Charges never absorb discount or tax.
    expect(byKey.charges!.discountCents).toBe(0);
    expect(byKey.charges!.taxCents).toBe(0);
  });

  it('flags a discrepancy when lines are missing (pre-migration history)', () => {
    const input = fixture();
    // Drop the merch lines: subtotal no longer covered by lines.
    const broken: ItemizedInput = { ...input, merchLines: [] };
    const result = buildItemizedSales(broken);
    expect(result.reconciliation.ok).toBe(false);
    const coverage = result.reconciliation.checks.find((c) => c.name.startsWith('Line coverage'));
    expect(coverage?.ok).toBe(false);
    expect(coverage?.diffCents).toBe(-(1200 + 5000));
  });
});

describe('buildMerchandiseReport', () => {
  it('rolls variants up under parent products with category subtotals', () => {
    const input = fixture();
    input.merchLines = [
      ...input.merchLines,
      {
        order_id: 'o2',
        kind: 'MERCHANDISE',
        name: 'Fuel',
        category: 'Fuel',
        variant: 'Full gallon',
        quantity: 3,
        unit_price_cents: 2400,
      },
    ];
    // Keep o2 reconciled: fold the new merch into its subtotal/total.
    input.orders = input.orders.map((o) =>
      o.id === 'o2'
        ? { ...o, subtotal_cents: o.subtotal_cents + 7200, total_cents: o.total_cents + 7200 }
        : o,
    );
    // o2 gains merch lines beyond its package lines — rebalance not needed for
    // the merchandise report (it doesn't check coverage), but keep sane inputs.

    const report = buildMerchandiseReport(input);

    const fuelCat = report.categories.find((c) => c.category === 'Fuel');
    expect(fuelCat).toBeDefined();
    // Fuel appears both as metered merchandise (by the gallon) and as a
    // post-trip charge — they roll up under ONE Fuel product, with the
    // unmetered charge as the base (no-variant) row.
    const fuelProduct = fuelCat!.products.find((p) => p.name === 'Fuel');
    expect(fuelProduct).toBeDefined();
    expect(fuelProduct!.hasVariants).toBe(true);
    expect(fuelProduct!.variants.map((v) => v.variant)).toEqual([
      null,
      '1/4 gallon',
      'Full gallon',
    ]);
    expect(fuelProduct!.quantity).toBe(2 + 3 + 1);
    expect(fuelProduct!.grossCents).toBe(1200 + 7200 + 2500);

    // Add-ons land in their own category.
    const addOns = report.categories.find((c) => c.category === 'Add-Ons');
    expect(addOns?.products[0]?.name).toBe('Cooler + Ice');

    // Grand total = Σ category subtotals.
    const sumCats = report.categories.reduce((s, c) => s + c.totals.totalCents, 0);
    expect(report.totals.totalCents).toBe(sumCats);
  });
});
