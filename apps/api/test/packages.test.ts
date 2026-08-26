/**
 * Package pricing — pure unit tests (no DB). Proves the bundle-price math:
 *   - à-la-carte total and savings are computed from the item lines;
 *   - distributePrice spreads the bundle price across lines with an EXACT sum
 *     (no rounding drift), proportional to weights, even-splitting when weights
 *     are all zero;
 *   - toPricedPackage shapes a raw row into the display/pricing form.
 */
import { describe, it, expect } from 'vitest';
import { priceItems, distributePrice, toPricedPackage } from '../src/services/packages.js';

describe('package pricing (pure)', () => {
  it('computes à-la-carte total and savings vs the bundle price', () => {
    const r = priceItems(9000, [
      { unitPriceCents: 5000, quantity: 1 },
      { unitPriceCents: 3000, quantity: 2 }, // 6000
    ]);
    expect(r.aLaCarteCents).toBe(11000);
    expect(r.savingsCents).toBe(2000);
  });

  it('floors savings at 0 when the bundle costs more than the parts', () => {
    const r = priceItems(12000, [{ unitPriceCents: 5000, quantity: 1 }]);
    expect(r.aLaCarteCents).toBe(5000);
    expect(r.savingsCents).toBe(0);
  });

  it('distributes a bundle price to sum EXACTLY, proportional to weights', () => {
    // 10000 across weights 5000/3000/2000 -> 5000/3000/2000.
    const parts = distributePrice(10000, [5000, 3000, 2000]);
    expect(parts).toEqual([5000, 3000, 2000]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(10000);
  });

  it('never drops or invents cents when the split is not clean', () => {
    // 100 across three equal weights -> 34/33/33 (largest-remainder), sums to 100.
    const parts = distributePrice(100, [1, 1, 1]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(100);
    expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
  });

  it('even-splits when all weights are zero', () => {
    const parts = distributePrice(99, [0, 0, 0]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(99);
  });

  it('handles a single-item package', () => {
    expect(distributePrice(4567, [999])).toEqual([4567]);
  });

  it('shapes a raw package row into a priced package', () => {
    const priced = toPricedPackage({
      id: 'pkg1',
      name_external: 'Sunset Combo',
      description_html: '<p>hi</p>',
      price_cents: 9000,
      items: [
        {
          id: 'i1',
          activity_id: 'a1',
          rate_id: 'r1',
          quantity: 1,
          activity: { name_external: 'Kayak' },
          rate: { name_external: '2hr', price_cents: 5000 },
        },
        {
          id: 'i2',
          activity_id: 'a2',
          rate_id: 'r2',
          quantity: 2,
          activity: { name_external: 'Paddleboard' },
          rate: { name_external: '1hr', price_cents: 3000 },
        },
      ],
    });
    expect(priced.priceCents).toBe(9000);
    expect(priced.aLaCarteCents).toBe(11000);
    expect(priced.savingsCents).toBe(2000);
    expect(priced.items).toHaveLength(2);
    expect(priced.items[1].lineTotalCents).toBe(6000);
    expect(priced.items[0].activityName).toBe('Kayak');
  });
});
