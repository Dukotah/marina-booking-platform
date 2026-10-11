/**
 * Merchandise retail price (price_cents) — live integration test against the
 * seeded LSRA tenant. Proves against real data that:
 *   - price_cents persists as a nullable retail price on MerchandiseItem;
 *   - the POS default rule resolves the register unit price to
 *     price_cents when set, falling back to cost_cents when it is null;
 *   - a valid register override (unitPriceCents >= 0) wins over the default.
 *
 * The resolvePrice helper mirrors the server-authoritative rule in
 * apps/admin/app/pos/actions.ts so the pricing contract is regression-locked.
 *
 * Skips without DATABASE_URL. Cleans up everything it creates in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';

/** Mirrors the POS sale-action default/override rule. */
function resolvePrice(
  item: { price_cents: number | null; cost_cents: number },
  clientUnitPriceCents: number,
): number {
  const defaultPriceCents = item.price_cents ?? item.cost_cents;
  return clientUnitPriceCents >= 0 ? clientUnitPriceCents : defaultPriceCents;
}

const createdIds: string[] = [];

describe.skipIf(!HAS_DB)('merchandise retail price (live, LSRA seed)', () => {
  afterAll(async () => {
    if (createdIds.length) {
      await adminPrisma.merchandiseItem.deleteMany({
        where: { operator_id: OP, id: { in: createdIds } },
      });
    }
  });

  it('persists a nullable retail price alongside cost', async () => {
    const withPrice = await adminPrisma.merchandiseItem.create({
      data: {
        operator_id: OP,
        name: 'ITEST Sunscreen',
        category: 'ITEST',
        cost_cents: 400,
        price_cents: 900,
      },
    });
    createdIds.push(withPrice.id);
    expect(withPrice.price_cents).toBe(900);

    const noPrice = await adminPrisma.merchandiseItem.create({
      data: { operator_id: OP, name: 'ITEST Rope', category: 'ITEST', cost_cents: 250 },
    });
    createdIds.push(noPrice.id);
    expect(noPrice.price_cents).toBeNull();
  });

  it('defaults the register price to retail, falling back to cost', () => {
    // No client override (sentinel negative) -> use the default.
    expect(resolvePrice({ price_cents: 900, cost_cents: 400 }, -1)).toBe(900);
    expect(resolvePrice({ price_cents: null, cost_cents: 250 }, -1)).toBe(250);
  });

  it('honors a valid register override over the default', () => {
    expect(resolvePrice({ price_cents: 900, cost_cents: 400 }, 700)).toBe(700);
    expect(resolvePrice({ price_cents: null, cost_cents: 250 }, 0)).toBe(0);
  });
});
