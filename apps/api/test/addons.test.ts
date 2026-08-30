/**
 * Add-on pricing, quantity resolution and refund allocation — PURE unit tests.
 * No database, no network, no clock. The DB-facing half of services/addons.ts
 * (the conditional stock UPDATE, the catalog CRUD) needs live Postgres and
 * belongs in an integration suite; what is proved here is every decision that
 * decides money or availability before a query is ever issued.
 */
import { describe, it, expect } from 'vitest';
import { calculatePricing } from '@marina/core';
import {
  AddOnError,
  addOnPricingItems,
  addOnSubtotalCents,
  buildAddOnOrderItems,
  isAddOnItem,
  isSeatItem,
  lineRefundCents,
  maxSelectableQuantity,
  priceAddOnSelections,
  remainingStock,
  resolveQuantity,
  seatCount,
  toOfferedAddOn,
  type AddOnDefinition,
} from '../src/services/addons.js';

/** A per-booking add-on with no stock cap unless a test sets one. */
function perBooking(over: Partial<AddOnDefinition> = {}): AddOnDefinition {
  return {
    id: 'cooler',
    activityId: 'act1',
    name: 'Cooler',
    description: 'Filled with ice',
    priceCents: 2500,
    basis: 'PER_BOOKING',
    maxPerBooking: null,
    stockTotal: null,
    stockSold: 0,
    isActive: true,
    sortIndex: 0,
    ...over,
  };
}

/** A per-guest add-on (one per person on the booking). */
function perGuest(over: Partial<AddOnDefinition> = {}): AddOnDefinition {
  return { ...perBooking(), id: 'jacket', name: 'Life jacket', priceCents: 1200, basis: 'PER_GUEST', sortIndex: 1, ...over };
}

describe('stock arithmetic', () => {
  it('reports unlimited stock as null, not as a big number', () => {
    expect(remainingStock(perBooking())).toBeNull();
  });

  it('reports what is left when a limit is set', () => {
    expect(remainingStock(perBooking({ stockTotal: 10, stockSold: 4 }))).toBe(6);
  });

  it('never reports negative stock even if the counter was corrupted', () => {
    expect(remainingStock(perBooking({ stockTotal: 3, stockSold: 5 }))).toBe(0);
  });
});

describe('maxSelectableQuantity', () => {
  it('lets a per-booking add-on go as high as the operator cap', () => {
    expect(maxSelectableQuantity(perBooking({ maxPerBooking: 3 }), 6)).toBe(3);
  });

  it('takes the tighter of the operator cap and remaining stock', () => {
    expect(maxSelectableQuantity(perBooking({ maxPerBooking: 5, stockTotal: 10, stockSold: 8 }), 6)).toBe(2);
  });

  it('caps a per-guest add-on at the party size', () => {
    expect(maxSelectableQuantity(perGuest(), 4)).toBe(4);
  });

  it('refuses a per-guest add-on outright when stock cannot cover the whole party', () => {
    // Four guests, three jackets left: selling three puts staff one short at the
    // counter, which is worse than not offering it at all.
    expect(maxSelectableQuantity(perGuest({ stockTotal: 20, stockSold: 17 }), 4)).toBe(0);
    expect(maxSelectableQuantity(perGuest({ stockTotal: 20, stockSold: 16 }), 4)).toBe(4);
  });

  it('offers nothing from an inactive add-on', () => {
    expect(maxSelectableQuantity(perBooking({ isActive: false }), 4)).toBe(0);
  });

  it('offers nothing when the party is empty', () => {
    expect(maxSelectableQuantity(perGuest(), 0)).toBe(0);
  });

  it('decorates a definition with both stock figures', () => {
    const offer = toOfferedAddOn(perBooking({ stockTotal: 4, stockSold: 1 }), 2);
    expect(offer.remainingStock).toBe(3);
    expect(offer.maxSelectable).toBe(3);
  });
});

describe('resolveQuantity', () => {
  it('collapses any positive per-guest request to the whole party', () => {
    // The guest toggled it on. "On" means one each — a party of 5 cannot buy 2.
    expect(resolveQuantity(perGuest(), 1, 5)).toBe(5);
    expect(resolveQuantity(perGuest(), 2, 5)).toBe(5);
  });

  it('clamps a per-booking request to the cap instead of trusting the client', () => {
    expect(resolveQuantity(perBooking({ maxPerBooking: 2 }), 99, 4)).toBe(2);
  });

  it('treats zero and negative requests as not selected', () => {
    expect(resolveQuantity(perBooking(), 0, 4)).toBe(0);
    expect(resolveQuantity(perBooking(), -3, 4)).toBe(0);
  });

  it('truncates a fractional quantity rather than pricing half a cooler', () => {
    expect(resolveQuantity(perBooking(), 2.9, 4)).toBe(2);
  });

  it('resolves to zero when the add-on is sold out', () => {
    expect(resolveQuantity(perBooking({ stockTotal: 2, stockSold: 2 }), 1, 4)).toBe(0);
  });
});

describe('priceAddOnSelections', () => {
  const defs = [perBooking(), perGuest()];

  it('prices per-booking by chosen quantity and per-guest by party size', () => {
    const lines = priceAddOnSelections(defs, [
      { addOnId: 'cooler', quantity: 2 },
      { addOnId: 'jacket', quantity: 1 },
    ], 4);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ addOnId: 'cooler', quantity: 2, lineTotalCents: 5000 });
    expect(lines[1]).toMatchObject({ addOnId: 'jacket', quantity: 4, lineTotalCents: 4800 });
  });

  it('emits lines in the operator sort order, not the order the client sent', () => {
    const lines = priceAddOnSelections(defs, [
      { addOnId: 'jacket', quantity: 1 },
      { addOnId: 'cooler', quantity: 1 },
    ], 2);
    expect(lines.map((l) => l.addOnId)).toEqual(['cooler', 'jacket']);
  });

  it('merges a duplicated id into one line instead of two that each pass the cap', () => {
    const lines = priceAddOnSelections([perBooking({ maxPerBooking: 3 })], [
      { addOnId: 'cooler', quantity: 2 },
      { addOnId: 'cooler', quantity: 2 },
    ], 4);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(3);
  });

  it('drops an unknown or sold-out add-on rather than losing the guest their seats', () => {
    const lines = priceAddOnSelections(
      [perBooking({ stockTotal: 1, stockSold: 1 })],
      [{ addOnId: 'cooler', quantity: 1 }, { addOnId: 'ghost', quantity: 1 }],
      2,
    );
    expect(lines).toEqual([]);
  });

  it('fails loudly instead of dropping when strict', () => {
    expect(() =>
      priceAddOnSelections([perBooking()], [{ addOnId: 'ghost', quantity: 1 }], 2, { strict: true }),
    ).toThrow(AddOnError);
    expect(() =>
      priceAddOnSelections(
        [perBooking({ stockTotal: 1, stockSold: 1 })],
        [{ addOnId: 'cooler', quantity: 1 }],
        2,
        { strict: true },
      ),
    ).toThrow(/no longer available/i);
  });

  it('ignores an add-on the guest did not select', () => {
    expect(priceAddOnSelections(defs, [{ addOnId: 'cooler', quantity: 0 }], 4)).toEqual([]);
  });

  it('sums line totals in integer cents', () => {
    const lines = priceAddOnSelections(defs, [
      { addOnId: 'cooler', quantity: 2 },
      { addOnId: 'jacket', quantity: 1 },
    ], 3);
    expect(addOnSubtotalCents(lines)).toBe(5000 + 3600);
  });
});

describe('the one totals path', () => {
  // The whole design claim: add-ons are extra PricingItems on the SAME
  // calculatePricing call, so tax and the processing fee reach them with no
  // add-on-specific maths anywhere.
  const fees = [
    { name: 'Sales Tax', type: 'PERCENT' as const, value: 8.5 },
    { name: 'Processing', type: 'PERCENT' as const, value: 2.9 },
  ];

  it('taxes an add-on at the same rate as the seats and grows the processing base', () => {
    const seats = { unitPriceCents: 20_000, quantity: 2 };
    const lines = priceAddOnSelections([perBooking()], [{ addOnId: 'cooler', quantity: 1 }], 2);

    const without = calculatePricing({ items: [seats], fees });
    const with_ = calculatePricing({ items: [seats, ...addOnPricingItems(lines)], fees });

    expect(without.subtotalCents).toBe(40_000);
    expect(without.taxCents).toBe(3400); // 8.5% of 400.00
    expect(without.processingFeeCents).toBe(1259); // 2.9% of 434.00 = 1258.6 -> 1259

    // The cooler lands in the SAME subtotal, so the same tax rate reaches it and
    // the processing fee is recomputed over the larger base. Note the deltas are
    // not the fee "on the cooler" — there is one rounding, over the whole order,
    // which is exactly why there is only one pricing call.
    expect(with_.subtotalCents).toBe(42_500);
    expect(with_.taxCents).toBe(3613); // 8.5% of 425.00 = 3612.5 -> 3613
    expect(with_.processingFeeCents).toBe(1337); // 2.9% of 461.13 = 1337.27 -> 1337
    expect(with_.totalCents).toBe(with_.subtotalCents + with_.taxCents + with_.processingFeeCents);
  });

  it('lets a percent promo discount the add-on too, because it is in the subtotal', () => {
    const seats = { unitPriceCents: 10_000, quantity: 1 };
    const lines = priceAddOnSelections([perBooking()], [{ addOnId: 'cooler', quantity: 1 }], 1);
    const priced = calculatePricing({
      items: [seats, ...addOnPricingItems(lines)],
      fees: [],
      promo: { discountType: 'PERCENT', discountValue: 10 },
    });
    expect(priced.subtotalCents).toBe(12_500);
    expect(priced.discountCents).toBe(1250); // 10% of seats AND cooler
  });

  it('applies no tax to an add-on on a tax-exempt order', () => {
    const lines = priceAddOnSelections([perBooking()], [{ addOnId: 'cooler', quantity: 1 }], 1);
    const priced = calculatePricing({
      items: [{ unitPriceCents: 10_000, quantity: 1 }, ...addOnPricingItems(lines)],
      fees,
      taxExempt: true,
    });
    expect(priced.taxCents).toBe(0);
  });
});

describe('order line items', () => {
  it('pins add-on lines to the booking’s activity, rate and slot', () => {
    // The cooler belongs to that trip on that boat at that time — which is
    // exactly what puts it on the right row of the day's manifest.
    const lines = priceAddOnSelections([perBooking()], [{ addOnId: 'cooler', quantity: 2 }], 3);
    const rows = buildAddOnOrderItems(lines, {
      activityId: 'act1',
      rateId: 'rate1',
      timeslotId: 'slot1',
    });
    expect(rows).toEqual([
      {
        activity_id: 'act1',
        rate_id: 'rate1',
        timeslot_id: 'slot1',
        quantity: 2,
        unit_price_cents: 2500,
        status: 'UPCOMING',
        add_on_id: 'cooler',
        add_on_name: 'Cooler',
      },
    ]);
  });

  it('carries no operator_id, so the tenant-composite parent supplies it (D-011)', () => {
    const lines = priceAddOnSelections([perBooking()], [{ addOnId: 'cooler', quantity: 1 }], 1);
    const [row] = buildAddOnOrderItems(lines, { activityId: 'a', rateId: 'r', timeslotId: 't' });
    expect(row).not.toHaveProperty('operator_id');
  });

  it('snapshots the name so a later rename cannot rewrite an old receipt', () => {
    const lines = priceAddOnSelections(
      [perBooking({ name: 'Cooler (large)' })],
      [{ addOnId: 'cooler', quantity: 1 }],
      1,
    );
    expect(buildAddOnOrderItems(lines, { activityId: 'a', rateId: 'r', timeslotId: 't' })[0]!.add_on_name)
      .toBe('Cooler (large)');
  });
});

describe('separating seats from add-ons', () => {
  const items = [
    { quantity: 4, add_on_id: null },
    { quantity: 2, add_on_id: 'cooler' },
    { quantity: 4, add_on_id: 'jacket' },
  ];

  it('identifies which rows are add-ons', () => {
    expect(items.map(isAddOnItem)).toEqual([false, true, true]);
    expect(items.map(isSeatItem)).toEqual([true, false, false]);
  });

  it('counts guests from seat lines only — a cooler is not a person', () => {
    expect(seatCount(items)).toBe(4);
  });

  it('treats a row with no add_on_id field at all as a seat', () => {
    expect(isSeatItem({})).toBe(true);
  });
});

describe('lineRefundCents', () => {
  it('refunds a line’s share of the total, tax and fees included', () => {
    // $200 seats + $25 cooler, 8.5% tax, no tip: total 24_413c.
    // The cooler is 2500/22500 of the subtotal, so its share carries its tax.
    const subtotals = [20_000, 2500];
    const total = 24_413;
    const cooler = lineRefundCents(subtotals, 1, total);
    expect(cooler).toBe(2713);
    // Refunding the bare $25 would quietly keep $2.13 of tax the operator never owed.
    expect(cooler).toBeGreaterThan(2500);
  });

  it('never loses or invents a penny across every line', () => {
    const subtotals = [3333, 3333, 3334];
    const total = 10_001; // deliberately not divisible cleanly
    const shares = subtotals.map((_, i) => lineRefundCents(subtotals, i, total));
    expect(shares.reduce((s, c) => s + c, 0)).toBe(total);
  });

  it('holds the tip back — it belongs to the crew, not to a cooler', () => {
    const subtotals = [10_000, 2500];
    const withTip = lineRefundCents(subtotals, 1, 15_000, 2500);
    const withoutTip = lineRefundCents(subtotals, 1, 12_500, 0);
    expect(withTip).toBe(withoutTip);
  });

  it('refuses an index that is not a line', () => {
    expect(() => lineRefundCents([100], 2, 100)).toThrow(AddOnError);
  });
});
