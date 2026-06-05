/**
 * Waiver template management — live integration test against the seeded LSRA tenant
 * on Neon. Legally-sound waivers + a tamper-evident audit trail are a go-live
 * requirement, so we verify against real data that:
 *   - publishing a new version (POST /templates, activate=true) creates a NEW Waiver
 *     row and deactivates the prior active one — exactly one active at a time;
 *   - publishing with activate=false stores an inactive draft without disturbing the
 *     current active version;
 *   - POST /templates/:id/activate switches the active version;
 *   - GET /active (public) always reflects the active version's html;
 *   - writes are gated at operator:manage (401 anon, 403 for a MANAGER without it),
 *     while listing is order:read.
 *
 * Never mutates an existing template's html (audit integrity). Restores the seed's
 * original active waiver and deletes its own versions in afterAll. Skips without
 * DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { app } from '../src/app.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const OWNER = { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner', 'content-type': 'application/json' };
const MANAGER_ID = 'dev-manager-waiver-itest';

let createdOwner = false;
let originalWaiverId = '';
const createdIds: string[] = [];

async function listTemplates() {
  const res = await app.request('/api/waivers/templates', {
    headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner' },
  });
  const body = (await res.json()) as {
    templates: Array<{ id: string; isActive: boolean; templateHtml: string; signatureCount: number }>;
  };
  return { status: res.status, templates: body.templates };
}

async function activeHtml(): Promise<string | null> {
  const res = await app.request('/api/waivers/active', { headers: { 'x-operator-slug': SLUG } });
  if (res.status !== 200) return null;
  const body = (await res.json()) as { waiver: { templateHtml: string } };
  return body.waiver.templateHtml;
}

describe.skipIf(!HAS_DB)('waiver template management (live vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    const loc = await adminPrisma.location.findFirst({ where: { operator_id: OP }, select: { id: true } });

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

    // A MANAGER lacks operator:manage → used to assert the 403 gate.
    await adminPrisma.staffMember.create({
      data: { operator_id: OP, auth_user_id: MANAGER_ID, name: 'Dev Manager', email: 'dev-manager-waiver@example.com', role: 'MANAGER', is_active: true, locations: loc ? { create: { location_id: loc.id } } : undefined },
    });

    const active = await adminPrisma.waiver.findFirst({
      where: { operator_id: OP, is_active: true },
      orderBy: { created_at: 'desc' },
      select: { id: true },
    });
    originalWaiverId = active?.id ?? '';
  });

  afterAll(async () => {
    if (createdIds.length) await adminPrisma.waiver.deleteMany({ where: { id: { in: createdIds } } });
    // Restore the seed's original active waiver as the sole active version.
    if (originalWaiverId) {
      await adminPrisma.waiver.updateMany({ where: { operator_id: OP, is_active: true }, data: { is_active: false } });
      await adminPrisma.waiver.update({ where: { id: originalWaiverId }, data: { is_active: true } });
    }
    await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: MANAGER_ID } });
    if (createdOwner) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
    await adminPrisma.$disconnect();
  });

  it('lists templates including the seed active version', async () => {
    const { status, templates } = await listTemplates();
    expect(status).toBe(200);
    expect(templates.length).toBeGreaterThanOrEqual(1);
    expect(templates.filter((t) => t.isActive)).toHaveLength(1);
    expect(templates.some((t) => t.id === originalWaiverId && t.isActive)).toBe(true);
  });

  it('publishes a new active version and deactivates the prior one', async () => {
    const html = '<p>Waiver v2 — itest</p>';
    const res = await app.request('/api/waivers/templates', {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({ name: 'Liability Waiver v2', templateHtml: html, requiresMinorSignature: true }),
    });
    expect(res.status).toBe(201);
    const { template } = (await res.json()) as { template: { id: string; isActive: boolean; signatureCount?: number } };
    expect(template.isActive).toBe(true);
    createdIds.push(template.id);

    const { templates } = await listTemplates();
    expect(templates.filter((t) => t.isActive)).toHaveLength(1); // exactly one active
    expect(templates.find((t) => t.id === template.id)!.isActive).toBe(true);
    expect(templates.find((t) => t.id === originalWaiverId)!.isActive).toBe(false); // prior deactivated
    expect(await activeHtml()).toBe(html); // public /active follows
  });

  it('publishes an inactive draft without disturbing the active version', async () => {
    const beforeActiveHtml = await activeHtml();
    const res = await app.request('/api/waivers/templates', {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({ name: 'Draft v3', templateHtml: '<p>draft</p>', activate: false }),
    });
    expect(res.status).toBe(201);
    const { template } = (await res.json()) as { template: { id: string; isActive: boolean } };
    expect(template.isActive).toBe(false);
    createdIds.push(template.id);

    expect(await activeHtml()).toBe(beforeActiveHtml); // unchanged
    const { templates } = await listTemplates();
    expect(templates.filter((t) => t.isActive)).toHaveLength(1);
  });

  it('activates a specific version (switching the active one)', async () => {
    const res = await app.request(`/api/waivers/templates/${originalWaiverId}/activate`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    const { templates } = await listTemplates();
    expect(templates.filter((t) => t.isActive)).toHaveLength(1);
    expect(templates.find((t) => t.id === originalWaiverId)!.isActive).toBe(true);
  });

  it('gates writes at operator:manage (401 anon, 403 for a MANAGER)', async () => {
    const anon = await app.request('/api/waivers/templates', {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', templateHtml: '<p>x</p>' }),
    });
    expect(anon.status).toBe(401);

    const manager = await app.request('/api/waivers/templates', {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': MANAGER_ID, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', templateHtml: '<p>x</p>' }),
    });
    expect(manager.status).toBe(403);
  });
});
