/**
 * Packages API — live HTTP integration test for the staff write routes against the
 * seeded LSRA tenant. Where packages.integration.test.ts drives the service, this
 * exercises the real Hono app via `app.request(...)`, covering the mutation wiring
 * the admin package builder depends on:
 *   - tenant-resolution middleware (`x-operator-slug`),
 *   - the dev-staff auth shim (`x-dev-staff-id`) + `activity:write` permission,
 *   - zod request validation, and
 *   - the create -> update (item replace) -> delete lifecycle + 404s.
 *
 * The four routes under test:
 *   POST   /api/packages          staff — create a package + its items
 *   PATCH  /api/packages/:id       staff — update + replace items
 *   DELETE /api/packages/:id       staff — delete a package
 *   GET    /api/packages/manage    staff — list all (used to confirm the delete)
 *
 * Skips without DATABASE_URL. Creates the dev-owner staff row if the seed omitted
 * it, and deletes everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { app } from '../src/app.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';

const staffJsonHeaders = {
  'x-operator-slug': SLUG,
  'x-dev-staff-id': 'dev-owner',
  'content-type': 'application/json',
};

let activityId = '';
let rateId = '';
let ratePrice = 0;
let createdStaff = false;
const createdPackageIds: string[] = [];

describe.skipIf(!HAS_DB)('packages API (live HTTP vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    const existingStaff = await adminPrisma.staffMember.findFirst({
      where: { operator_id: OP, auth_user_id: 'dev-owner' },
      select: { id: true },
    });
    if (!existingStaff) {
      const loc = await adminPrisma.location.findFirst({
        where: { operator_id: OP },
        select: { id: true },
      });
      await adminPrisma.staffMember.create({
        data: {
          operator_id: OP,
          auth_user_id: 'dev-owner',
          name: 'Dev Owner',
          email: 'dev-owner@example.com',
          role: 'OWNER',
          is_active: true,
          locations: loc ? { create: { location_id: loc.id } } : undefined,
        },
      });
      createdStaff = true;
    }

    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true },
      },
      select: { id: true, activity_id: true, price_cents: true },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');
    activityId = rate.activity_id;
    rateId = rate.id;
    ratePrice = rate.price_cents;
  });

  afterAll(async () => {
    for (const id of createdPackageIds) await adminPrisma.package.deleteMany({ where: { id } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
    await adminPrisma.$disconnect();
  });

  it('creates, updates (replacing items), and deletes a package', async () => {
    // Create with one item.
    const createRes = await app.request('/api/packages', {
      method: 'POST',
      headers: staffJsonHeaders,
      body: JSON.stringify({
        nameInternal: 'routes-itest',
        nameExternal: 'Routes Integration Bundle',
        priceCents: Math.max(100, ratePrice),
        status: 'ACTIVE',
        items: [{ activityId, rateId, quantity: 1 }],
      }),
    });
    expect(createRes.status).toBe(201);
    const { package: created } = (await createRes.json()) as { package: { id: string; items: unknown[] } };
    createdPackageIds.push(created.id);
    expect(created.items).toHaveLength(1);

    // Update: bump price, rename, replace items with a 2× line.
    const patchRes = await app.request(`/api/packages/${created.id}`, {
      method: 'PATCH',
      headers: staffJsonHeaders,
      body: JSON.stringify({
        nameInternal: 'routes-itest',
        nameExternal: 'Routes Integration Bundle (updated)',
        priceCents: Math.max(100, ratePrice) + 500,
        status: 'INACTIVE',
        items: [{ activityId, rateId, quantity: 2 }],
      }),
    });
    expect(patchRes.status).toBe(200);
    const { package: updated } = (await patchRes.json()) as {
      package: { name_external: string; status: string; items: Array<{ quantity: number }> };
    };
    expect(updated.name_external).toBe('Routes Integration Bundle (updated)');
    expect(updated.status).toBe('INACTIVE');
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0].quantity).toBe(2);

    // Delete.
    const delRes = await app.request(`/api/packages/${created.id}`, {
      method: 'DELETE',
      headers: staffJsonHeaders,
    });
    expect(delRes.status).toBe(200);

    // Confirm it's gone from the staff list.
    const listRes = await app.request('/api/packages/manage', { headers: staffJsonHeaders });
    expect(listRes.status).toBe(200);
    const { packages } = (await listRes.json()) as { packages: Array<{ id: string }> };
    expect(packages.some((p) => p.id === created.id)).toBe(false);
  });

  it('404s when updating or deleting a missing package', async () => {
    const patchRes = await app.request('/api/packages/does-not-exist', {
      method: 'PATCH',
      headers: staffJsonHeaders,
      body: JSON.stringify({
        nameInternal: 'x',
        nameExternal: 'x',
        priceCents: 1000,
        items: [{ activityId, rateId, quantity: 1 }],
      }),
    });
    expect(patchRes.status).toBe(404);

    const delRes = await app.request('/api/packages/does-not-exist', {
      method: 'DELETE',
      headers: staffJsonHeaders,
    });
    expect(delRes.status).toBe(404);
  });

  it('rejects an invalid create payload with 400', async () => {
    const res = await app.request('/api/packages', {
      method: 'POST',
      headers: staffJsonHeaders,
      body: JSON.stringify({ nameInternal: '', nameExternal: '', priceCents: -1, items: [] }),
    });
    expect(res.status).toBe(400);
  });
});
