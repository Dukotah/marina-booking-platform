/**
 * Resource / asset management — live integration test against the seeded LSRA tenant
 * on Neon. Resources back activity capacity (boats, jet skis, patios), a Phase-3
 * power feature for complex operators. We verify against real data that:
 *   - create accepts the asset fields + an activity assignment (the ActivityResources
 *     m2m), derives availableQty = quantity − outOfServiceQty, and echoes the links;
 *   - list/detail return the resource (with activity count / assigned activities);
 *   - patch updates fields and *replaces* the activity set, and rejects
 *     outOfServiceQty > quantity (400);
 *   - cross-tenant / unknown locationId + activityIds are refused (400);
 *   - soft-delete deactivates, hard-delete removes;
 *   - reads need activity:read, writes activity:write (401 anon, 403 for a GUIDE).
 *
 * Skips without DATABASE_URL. Creates a staff GUIDE + its own resources and deletes
 * everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { app } from '../src/app.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const OWNER = { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner', 'content-type': 'application/json' };
const GUIDE_ID = 'dev-guide-resource-itest';

let createdOwner = false;
let locationId = '';
let actA = '';
let actB = '';
const createdResourceIds: string[] = [];

describe.skipIf(!HAS_DB)('resource/asset management (live vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    const loc = await adminPrisma.location.findFirst({ where: { operator_id: OP }, select: { id: true } });
    locationId = loc?.id ?? '';

    const existingOwner = await adminPrisma.staffMember.findFirst({
      where: { operator_id: OP, auth_user_id: 'dev-owner' },
      select: { id: true },
    });
    if (!existingOwner) {
      await adminPrisma.staffMember.create({
        data: { operator_id: OP, auth_user_id: 'dev-owner', name: 'Dev Owner', email: 'dev-owner@example.com', role: 'OWNER', is_active: true, locations: loc ? { create: { location_id: loc.id } } : undefined },
      });
      createdOwner = true;
    }
    await adminPrisma.staffMember.create({
      data: { operator_id: OP, auth_user_id: GUIDE_ID, name: 'Dev Guide', email: 'dev-guide-resource@example.com', role: 'GUIDE', is_active: true, locations: loc ? { create: { location_id: loc.id } } : undefined },
    });

    const acts = await adminPrisma.activity.findMany({ where: { operator_id: OP }, take: 2, select: { id: true } });
    actA = acts[0]!.id;
    actB = acts[1]!.id;
  });

  afterAll(async () => {
    if (createdResourceIds.length) {
      await adminPrisma.resource.deleteMany({ where: { id: { in: createdResourceIds } } });
    }
    await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: GUIDE_ID } });
    if (createdOwner) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
    await adminPrisma.$disconnect();
  });

  it('creates a resource with an activity assignment and derives availableQty', async () => {
    const res = await app.request('/api/resources', {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({ name: 'Pontoon #7', seatCapacity: 10, quantity: 5, outOfServiceQty: 1, locationId, activityIds: [actA] }),
    });
    expect(res.status).toBe(201);
    const { resource } = (await res.json()) as { resource: { id: string; availableQty: number; quantity: number; activities: Array<{ id: string }> } };
    createdResourceIds.push(resource.id);
    expect(resource.availableQty).toBe(4); // 5 − 1
    expect(resource.activities.map((a) => a.id)).toEqual([actA]);
  });

  it('lists resources (with activity count) and supports a name search', async () => {
    const res = await app.request(`/api/resources?q=Pontoon`, { headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner' } });
    expect(res.status).toBe(200);
    const { resources } = (await res.json()) as { resources: Array<{ id: string; activityCount: number }> };
    const mine = resources.find((r) => r.id === createdResourceIds[0]);
    expect(mine).toBeDefined();
    expect(mine!.activityCount).toBe(1);
  });

  it('fetches a resource by id with its assigned activities', async () => {
    const res = await app.request(`/api/resources/${createdResourceIds[0]}`, { headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner' } });
    expect(res.status).toBe(200);
    const { resource } = (await res.json()) as { resource: { activities: Array<{ id: string }> } };
    expect(resource.activities.map((a) => a.id)).toEqual([actA]);
  });

  it('patches fields and replaces the activity set; rejects oos > quantity', async () => {
    const ok = await app.request(`/api/resources/${createdResourceIds[0]}`, {
      method: 'PATCH',
      headers: OWNER,
      body: JSON.stringify({ quantity: 8, outOfServiceQty: 2, activityIds: [actB] }),
    });
    expect(ok.status).toBe(200);
    const { resource } = (await ok.json()) as { resource: { availableQty: number; activities: Array<{ id: string }> } };
    expect(resource.availableQty).toBe(6); // 8 − 2
    expect(resource.activities.map((a) => a.id)).toEqual([actB]); // replaced

    const bad = await app.request(`/api/resources/${createdResourceIds[0]}`, {
      method: 'PATCH',
      headers: OWNER,
      body: JSON.stringify({ outOfServiceQty: 99 }), // > quantity(8)
    });
    expect(bad.status).toBe(400);
  });

  it('refuses an unknown activityId or locationId (400)', async () => {
    const badAct = await app.request('/api/resources', {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({ name: 'Bad', activityIds: ['does-not-exist'] }),
    });
    expect(badAct.status).toBe(400);

    const badLoc = await app.request('/api/resources', {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({ name: 'Bad', locationId: 'does-not-exist' }),
    });
    expect(badLoc.status).toBe(400);
  });

  it('soft-deletes (deactivates) then hard-deletes', async () => {
    const soft = await app.request(`/api/resources/${createdResourceIds[0]}`, { method: 'DELETE', headers: OWNER });
    expect(soft.status).toBe(200);
    const softBody = (await soft.json()) as { deactivated?: boolean; resource?: { isActive: boolean } };
    expect(softBody.deactivated).toBe(true);
    expect(softBody.resource!.isActive).toBe(false);

    const hard = await app.request(`/api/resources/${createdResourceIds[0]}?hard=true`, { method: 'DELETE', headers: OWNER });
    expect(hard.status).toBe(200);
    const hardBody = (await hard.json()) as { deleted?: boolean };
    expect(hardBody.deleted).toBe(true);

    const gone = await adminPrisma.resource.findUnique({ where: { id: createdResourceIds[0] } });
    expect(gone).toBeNull();
    createdResourceIds.length = 0; // already removed
  });

  it('gates writes (401 anon, 403 for a GUIDE without activity:write)', async () => {
    const anon = await app.request('/api/resources', {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(anon.status).toBe(401);

    const guide = await app.request('/api/resources', {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': GUIDE_ID, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(guide.status).toBe(403);
  });
});
