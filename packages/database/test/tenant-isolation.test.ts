/**
 * Cross-tenant isolation test — the single most important guarantee in the
 * platform (docs/CONTEXT.md: "operator A can never see operator B's data, even
 * via crafted requests"; docs/ARCHITECTURE.md § Tenant Isolation).
 *
 * This exercises the DB-layer backstop (Postgres Row-Level Security, prisma/rls.sql)
 * together with the app-layer tenant-scoped client (src/client.ts `forOperator` /
 * `withTenant`). It seeds two independent operators (A and B), each with their own
 * activity / customer / order graph, then proves that A's tenant scope:
 *   1. cannot READ any of B's rows (queries fail closed -> empty / zero), and
 *   2. cannot WRITE rows under B (RLS `WITH CHECK` rejects the insert).
 *
 * REQUIREMENTS:
 *   - DATABASE_URL must point at a Postgres database (e.g. Neon) where the Prisma
 *     schema has been migrated AND prisma/rls.sql has been applied (RLS is what
 *     this test asserts on — without it, the cross-tenant reads would succeed and
 *     these assertions would correctly fail). DIRECT_URL is used for migrations.
 *   - Run with: pnpm --filter @marina/database test   (needs vitest configured;
 *     see followups in the slice report).
 *
 * The test is self-contained and idempotent: it uses unique operator ids and
 * cleans up (via adminPrisma) in afterAll, so it is safe to run repeatedly and
 * against a shared dev database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPrisma, forOperator, withTenant } from '../src/index.js';

// Two fully independent tenants. Fixed-but-unique ids keep the test deterministic
// and easy to clean up without disturbing seed data (operator "lsra").
const OP_A = 'test-iso-op-a';
const OP_B = 'test-iso-op-b';

interface SeededTenant {
  operatorId: string;
  activityId: string;
  rateId: string;
  timeslotId: string;
  customerId: string;
  orderId: string;
}

/**
 * Seed one operator's full booking graph inside that operator's own tenant scope.
 * `withTenant` opens a single transaction with the `app.current_operator_id` GUC
 * set to `operatorId`, so every insert passes RLS's `WITH CHECK (operator_id = GUC)`
 * even though FORCE ROW LEVEL SECURITY is on. This mirrors how prisma/seed.ts seeds.
 */
async function seedTenant(operatorId: string, suffix: string): Promise<SeededTenant> {
  return withTenant(operatorId, async (tx) => {
    const operator = await tx.operator.create({
      data: {
        id: operatorId,
        slug: `test-iso-${suffix}`,
        name_internal: `Test Iso Operator ${suffix.toUpperCase()}`,
        name_external: `Test Iso Marina ${suffix.toUpperCase()}`,
        location_code: `ISO${suffix.toUpperCase()}`,
        brand_color: '#0ea5e9',
      },
    });

    const activity = await tx.activity.create({
      data: {
        operator_id: operator.id,
        name_internal: `Iso Pontoon ${suffix}`,
        name_external: `Iso Pontoon ${suffix}`,
        category: 'BOAT',
        max_participants: 10,
      },
    });

    const rate = await tx.rate.create({
      data: {
        operator_id: operator.id,
        activity_id: activity.id,
        name_internal: 'Half Day',
        name_external: 'Half Day (4 hr)',
        price_cents: 35000,
        duration_minutes: 240,
      },
    });

    const timeslot = await tx.timeslot.create({
      data: {
        operator_id: operator.id,
        activity_id: activity.id,
        datetime: new Date('2026-07-04T17:00:00.000Z'),
        capacity_total: 10,
      },
    });

    const customer = await tx.customer.create({
      data: {
        operator_id: operator.id,
        first_name: 'Pat',
        last_name: `Tenant${suffix.toUpperCase()}`,
        // Same email across both tenants on purpose: the @@unique is
        // [operator_id, email], so isolation must still hold per-tenant.
        email: 'shared-guest@example.com',
      },
    });

    const order = await tx.order.create({
      data: {
        operator_id: operator.id,
        // order_number is globally @unique, so it must differ per tenant.
        order_number: `ISO-${suffix.toUpperCase()}-0001`,
        customer_id: customer.id,
        subtotal_cents: 35000,
        total_cents: 35000,
        balance_due_cents: 35000,
        items: {
          create: {
            operator_id: operator.id,
            activity_id: activity.id,
            rate_id: rate.id,
            timeslot_id: timeslot.id,
            quantity: 1,
            unit_price_cents: 35000,
          },
        },
      },
    });

    return {
      operatorId: operator.id,
      activityId: activity.id,
      rateId: rate.id,
      timeslotId: timeslot.id,
      customerId: customer.id,
      orderId: order.id,
    };
  });
}

let tenantA: SeededTenant;
let tenantB: SeededTenant;

// This suite asserts on live Postgres RLS, so it only runs when a database is
// configured. Without DATABASE_URL it is SKIPPED (not failed) so the root
// `pnpm test` stays green pre-Neon; it auto-activates the moment the connection
// string is in .env and the schema + prisma/rls.sql have been applied.
const HAS_DB = Boolean(process.env.DATABASE_URL);
if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    '[tenant-isolation] DATABASE_URL not set — skipping cross-tenant isolation suite. ' +
      'Set DATABASE_URL (Neon), run `pnpm db:migrate && pnpm db:rls && pnpm db:seed`, then re-run.',
  );
}

describe.skipIf(!HAS_DB)('cross-tenant isolation (RLS + tenant-scoped client)', () => {
  beforeAll(async () => {
    // Clean any leftovers from a previous run, then seed two tenants. Cleanup runs
    // through adminPrisma but must still satisfy RLS WITH CHECK / USING, so we scope
    // each delete to its tenant via the GUC inside a transaction.
    await cleanup();
    tenantA = await seedTenant(OP_A, 'a');
    tenantB = await seedTenant(OP_B, 'b');
  });

  afterAll(async () => {
    await cleanup();
    await adminPrisma.$disconnect();
  });

  it('seeds each tenant so it can see its OWN data (control)', async () => {
    const dbA = forOperator(OP_A);
    const dbB = forOperator(OP_B);

    await expect(dbA.activity.count()).resolves.toBe(1);
    await expect(dbA.order.count()).resolves.toBe(1);
    await expect(dbA.customer.count()).resolves.toBe(1);

    await expect(dbB.activity.count()).resolves.toBe(1);
    await expect(dbB.order.count()).resolves.toBe(1);
    await expect(dbB.customer.count()).resolves.toBe(1);

    // Operator can read its own operator row.
    await expect(dbA.operator.findUnique({ where: { id: OP_A } })).resolves.not.toBeNull();
  });

  it("A cannot READ B's activities", async () => {
    const dbA = forOperator(OP_A);

    // count over the whole table returns only A's rows.
    expect(await dbA.activity.count()).toBe(1);

    // Targeted lookup of B's row id is invisible to A.
    expect(await dbA.activity.findUnique({ where: { id: tenantB.activityId } })).toBeNull();
    expect(
      await dbA.activity.findFirst({ where: { id: tenantB.activityId } }),
    ).toBeNull();

    // Even an explicit where-clause naming B's operator_id returns nothing — RLS
    // filters before the predicate is applied.
    expect(await dbA.activity.findMany({ where: { operator_id: OP_B } })).toEqual([]);

    // Rates/timeslots (sub-resources) are equally invisible.
    expect(await dbA.rate.findUnique({ where: { id: tenantB.rateId } })).toBeNull();
    expect(await dbA.timeslot.findUnique({ where: { id: tenantB.timeslotId } })).toBeNull();
  });

  it("A cannot READ B's orders", async () => {
    const dbA = forOperator(OP_A);

    expect(await dbA.order.count()).toBe(1);
    expect(await dbA.order.findUnique({ where: { id: tenantB.orderId } })).toBeNull();
    expect(
      await dbA.order.findUnique({ where: { order_number: 'ISO-B-0001' } }),
    ).toBeNull();
    expect(await dbA.order.findMany({ where: { operator_id: OP_B } })).toEqual([]);

    // Order items belonging to B are invisible too.
    expect(await dbA.orderItem.count({ where: { order_id: tenantB.orderId } })).toBe(0);
  });

  it("A cannot READ B's customers", async () => {
    const dbA = forOperator(OP_A);

    expect(await dbA.customer.count()).toBe(1);
    expect(await dbA.customer.findUnique({ where: { id: tenantB.customerId } })).toBeNull();

    // The composite unique [operator_id, email] for B is not reachable from A even
    // though A has a customer with the same email address.
    expect(
      await dbA.customer.findUnique({
        where: { operator_id_email: { operator_id: OP_B, email: 'shared-guest@example.com' } },
      }),
    ).toBeNull();

    // The only customer A sees is A's own.
    const visible = await dbA.customer.findMany();
    expect(visible).toHaveLength(1);
    expect(visible[0]?.operator_id).toBe(OP_A);
  });

  it("B (symmetrically) cannot READ A's data", async () => {
    const dbB = forOperator(OP_B);

    expect(await dbB.activity.findUnique({ where: { id: tenantA.activityId } })).toBeNull();
    expect(await dbB.order.findUnique({ where: { id: tenantA.orderId } })).toBeNull();
    expect(await dbB.customer.findUnique({ where: { id: tenantA.customerId } })).toBeNull();
    expect(await dbB.order.findMany({ where: { operator_id: OP_A } })).toEqual([]);
  });

  it("A cannot CREATE rows stamped with B's operator_id (RLS WITH CHECK rejects)", async () => {
    const dbA = forOperator(OP_A);

    // Attempting to write a row whose operator_id is B, while scoped as A, must be
    // rejected by the RLS WITH CHECK clause (Postgres raises an error). The insert
    // must NOT silently succeed.
    await expect(
      dbA.activity.create({
        data: {
          operator_id: OP_B,
          name_internal: 'Smuggled Activity',
          name_external: 'Smuggled Activity',
          category: 'BOAT',
        },
      }),
    ).rejects.toThrow();

    await expect(
      dbA.customer.create({
        data: {
          operator_id: OP_B,
          first_name: 'Mallory',
          last_name: 'Cross',
          email: 'mallory-cross@example.com',
        },
      }),
    ).rejects.toThrow();

    // And the write truly did not land: B's tenant scope sees no new rows.
    const dbB = forOperator(OP_B);
    expect(await dbB.activity.count()).toBe(1);
    expect(await dbB.customer.count()).toBe(1);
  });

  // KNOWN GAP (docs/DECISIONS.md D-010, ROADMAP 0.13): Postgres foreign-key checks
  // bypass RLS, so a tenant CAN create one of its own rows that references another
  // tenant's row by id. The referencing row stays owned/readable only by the attacker
  // and the referenced row remains invisible to them, so exposure is limited — but it
  // is a real integrity gap. The fix is tenant-composite FKs (@@unique([operator_id,
  // id]) on parents). Skipped (not deleted) until that hardening lands.
  it.skip("A cannot ATTACH a child row to B's parent (cross-tenant foreign key)", async () => {
    const dbA = forOperator(OP_A);

    // Create a rate under A but pointing at B's activity. Once tenant-composite FKs
    // land, (operator_id=A, activity_id=B's) will not match any Activity and the
    // insert must error.
    await expect(
      dbA.rate.create({
        data: {
          operator_id: OP_A,
          activity_id: tenantB.activityId,
          name_internal: 'Cross Rate',
          name_external: 'Cross Rate',
          price_cents: 9999,
          duration_minutes: 60,
        },
      }),
    ).rejects.toThrow();

    // B's activity still has only its own original rate.
    const dbB = forOperator(OP_B);
    expect(await dbB.rate.count({ where: { activity_id: tenantB.activityId } })).toBe(1);
  });

  it("A's bulk update/delete cannot touch B's rows", async () => {
    const dbA = forOperator(OP_A);

    // A blanket updateMany / deleteMany from A's scope can only ever affect A's rows.
    const updated = await dbA.activity.updateMany({ data: { status: 'INACTIVE' } });
    expect(updated.count).toBe(1); // only A's single activity

    // B's activity is untouched and still ACTIVE.
    const dbB = forOperator(OP_B);
    const bActivity = await dbB.activity.findUnique({ where: { id: tenantB.activityId } });
    expect(bActivity?.status).toBe('ACTIVE');

    // Restore A's activity so the test leaves no surprising state mid-suite.
    await dbA.activity.updateMany({ data: { status: 'ACTIVE' } });
  });
});

/**
 * Remove both test operators (cascades to all their child rows). Each delete is
 * scoped to its tenant via the GUC so it satisfies RLS even under FORCE RLS. Uses
 * deleteMany (no-op when absent) so cleanup is safe before seeding and after.
 */
async function cleanup(): Promise<void> {
  for (const id of [OP_A, OP_B]) {
    await withTenant(id, async (tx) => {
      // OrderItem -> Activity is intentionally Restrict (historical bookings protect
      // their activity from deletion), so the Operator cascade can't drop activities
      // while order items still reference them. Clear the order graph first, then the
      // Operator cascade removes everything else. All scoped to this tenant via RLS.
      await tx.orderItem.deleteMany({});
      await tx.order.deleteMany({});
      await tx.operator.deleteMany({ where: { id } });
    });
  }
}
