/**
 * Customers CRM API — live HTTP integration test against the seeded LSRA tenant on
 * Neon. Drives the real Hono app via `app.request(...)` so the full request path is
 * exercised: tenant resolution middleware -> RLS-scoped client -> zod validation ->
 * handler -> the dev-staff auth shim.
 *
 * Covers:
 *   - GET  /api/customers          list (staff, pagination meta)
 *   - GET  /api/customers?q=       free-text search narrows results
 *   - GET  /api/customers?tag=     tag filter narrows results
 *   - GET  /api/customers/:id      returns the test customer with orders array
 *   - GET  /api/customers/:id      returns 404 for an unknown id
 *   - POST /api/customers          creates a new customer (201), returns camelCase shape
 *   - POST /api/customers          409 on duplicate email within the same tenant
 *   - POST /api/customers          400 on invalid payload (missing required fields)
 *   - PATCH /api/customers/:id     updates contact/CRM fields, reflects changes in response
 *   - PATCH /api/customers/:id     400 when no fields are provided (empty-patch guard)
 *   - PATCH /api/customers/:id     404 for unknown id
 *   - GET  /api/customers          401 without staff identity header
 *   - POST /api/customers          401 without staff identity header
 *   - PATCH /api/customers/:id     401 without staff identity header
 *
 * Skips without DATABASE_URL. Creates its own Customer row (+ the dev-owner staff
 * row if missing) and deletes everything it created in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { app } from '../src/app.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const TEST_EMAIL = 'customers-itest@example.com';
const STAFF_HEADERS = {
  'x-operator-slug': SLUG,
  'x-dev-staff-id': 'dev-owner',
  'content-type': 'application/json',
};
const PUBLIC_HEADERS = {
  'x-operator-slug': SLUG,
  'content-type': 'application/json',
};

let customerId = '';
let createdStaff = false;

describe.skipIf(!HAS_DB)('customers CRM API (live HTTP vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    // Ensure a dev-owner staff member exists for staff-only endpoints (the dev shim
    // resolves `x-dev-staff-id: dev-owner` to this row). Track if we created it.
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

    // Clean up any leftover row from a previous run before creating a fresh one.
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });

    const customer = await adminPrisma.customer.create({
      data: {
        operator_id: OP,
        first_name: 'Integration',
        last_name: 'Tester',
        email: TEST_EMAIL,
        phone: '555-000-1234',
        tags: ['vip', 'itest'],
        notes: 'Created by customers integration test',
      },
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    // Also clean up any POST-created duplicate guard test rows that may have slipped through.
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: 'customers-itest-post@example.com' } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
    await adminPrisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // List / search
  // -------------------------------------------------------------------------

  it('GET /api/customers lists customers with pagination metadata', async () => {
    const res = await app.request('/api/customers', { headers: STAFF_HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      customers: Array<{ id: string; firstName: string; email: string }>;
      pagination: { page: number; pageSize: number; total: number; totalPages: number };
    };
    expect(Array.isArray(body.customers)).toBe(true);
    expect(body.customers.length).toBeGreaterThanOrEqual(1);
    expect(body.pagination.page).toBe(1);
    expect(typeof body.pagination.total).toBe('number');
    expect(body.pagination.totalPages).toBeGreaterThanOrEqual(1);
    // Our test customer must appear in the full list (or at most one full page away
    // if there are many customers — we verify existence via a targeted search test).
  });

  it('GET /api/customers?q= free-text search returns our test customer', async () => {
    const res = await app.request(`/api/customers?q=customers-itest`, { headers: STAFF_HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      customers: Array<{ id: string; email: string; firstName: string; lastName: string }>;
      pagination: { total: number };
    };
    expect(body.customers.some((c) => c.id === customerId)).toBe(true);
    const hit = body.customers.find((c) => c.id === customerId)!;
    expect(hit.firstName).toBe('Integration');
    expect(hit.lastName).toBe('Tester');
  });

  it('GET /api/customers?tag= tag filter narrows results to tagged customers', async () => {
    const res = await app.request(`/api/customers?tag=itest`, { headers: STAFF_HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      customers: Array<{ id: string; tags: string[] }>;
      pagination: { total: number };
    };
    // Every returned customer must carry the 'itest' tag.
    for (const c of body.customers) {
      expect(c.tags).toContain('itest');
    }
    expect(body.customers.some((c) => c.id === customerId)).toBe(true);
  });

  it('GET /api/customers returns 401 without a staff identity', async () => {
    const res = await app.request('/api/customers', { headers: PUBLIC_HEADERS });
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Get single customer
  // -------------------------------------------------------------------------

  it('GET /api/customers/:id returns the customer record with an orders array', async () => {
    const res = await app.request(`/api/customers/${customerId}`, { headers: STAFF_HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      customer: {
        id: string;
        firstName: string;
        lastName: string;
        email: string;
        phone: string | null;
        tags: string[];
        notes: string | null;
        lifetimeValueCents: number;
        totalBookings: number;
        waiverOnFile: boolean;
      };
      orders: Array<{ id: string; status: string }>;
    };
    expect(body.customer.id).toBe(customerId);
    expect(body.customer.firstName).toBe('Integration');
    expect(body.customer.lastName).toBe('Tester');
    expect(body.customer.email).toBe(TEST_EMAIL);
    expect(body.customer.phone).toBe('555-000-1234');
    expect(body.customer.tags).toContain('itest');
    expect(typeof body.customer.lifetimeValueCents).toBe('number');
    expect(typeof body.customer.totalBookings).toBe('number');
    expect(typeof body.customer.waiverOnFile).toBe('boolean');
    expect(Array.isArray(body.orders)).toBe(true);
  });

  it('GET /api/customers/:id returns 404 for an unknown id', async () => {
    const res = await app.request('/api/customers/00000000-0000-0000-0000-000000000000', {
      headers: STAFF_HEADERS,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not found/i);
  });

  // -------------------------------------------------------------------------
  // Create customer
  // -------------------------------------------------------------------------

  it('POST /api/customers creates a new customer and returns 201 with camelCase shape', async () => {
    // Clean up before creation in case a previous run left a row.
    await adminPrisma.customer.deleteMany({
      where: { operator_id: OP, email: 'customers-itest-post@example.com' },
    });

    const res = await app.request('/api/customers', {
      method: 'POST',
      headers: STAFF_HEADERS,
      body: JSON.stringify({
        first_name: 'Post',
        last_name: 'Created',
        email: 'customers-itest-post@example.com',
        phone: '555-999-0000',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      customer: { id: string; firstName: string; lastName: string; email: string };
    };
    expect(body.customer.id).toBeTruthy();
    expect(body.customer.firstName).toBe('Post');
    expect(body.customer.lastName).toBe('Created');
    expect(body.customer.email).toBe('customers-itest-post@example.com');
  });

  it('POST /api/customers returns 409 on duplicate email within the tenant', async () => {
    // TEST_EMAIL was created in beforeAll so it already exists.
    const res = await app.request('/api/customers', {
      method: 'POST',
      headers: STAFF_HEADERS,
      body: JSON.stringify({
        first_name: 'Dupe',
        last_name: 'Customer',
        email: TEST_EMAIL,
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; customerId: string };
    expect(body.error).toMatch(/already exists/i);
    expect(body.customerId).toBe(customerId);
  });

  it('POST /api/customers returns 400 on an invalid payload (missing required fields)', async () => {
    const res = await app.request('/api/customers', {
      method: 'POST',
      headers: STAFF_HEADERS,
      body: JSON.stringify({ first_name: 'Only' }), // missing last_name and email
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toMatch(/validation/i);
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('POST /api/customers returns 401 without a staff identity', async () => {
    const res = await app.request('/api/customers', {
      method: 'POST',
      headers: PUBLIC_HEADERS,
      body: JSON.stringify({ first_name: 'No', last_name: 'Auth', email: 'no-auth@example.com' }),
    });
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Update (PATCH) customer
  // -------------------------------------------------------------------------

  it('PATCH /api/customers/:id updates contact and CRM fields, reflects changes in response', async () => {
    const res = await app.request(`/api/customers/${customerId}`, {
      method: 'PATCH',
      headers: STAFF_HEADERS,
      body: JSON.stringify({
        first_name: 'Updated',
        notes: 'Patched by integration test',
        tags: ['vip', 'itest', 'patched'],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      customer: { id: string; firstName: string; notes: string | null; tags: string[] };
    };
    expect(body.customer.id).toBe(customerId);
    expect(body.customer.firstName).toBe('Updated');
    expect(body.customer.notes).toBe('Patched by integration test');
    expect(body.customer.tags).toContain('patched');

    // Confirm the change persisted in the DB.
    const row = await adminPrisma.customer.findUnique({ where: { id: customerId } });
    expect(row!.first_name).toBe('Updated');
    expect(row!.notes).toBe('Patched by integration test');
  });

  it('PATCH /api/customers/:id returns 400 when the payload has no fields (empty-patch guard)', async () => {
    const res = await app.request(`/api/customers/${customerId}`, {
      method: 'PATCH',
      headers: STAFF_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/validation/i);
  });

  it('PATCH /api/customers/:id returns 404 for an unknown id', async () => {
    const res = await app.request('/api/customers/00000000-0000-0000-0000-000000000000', {
      method: 'PATCH',
      headers: STAFF_HEADERS,
      body: JSON.stringify({ notes: 'ghost' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not found/i);
  });

  it('PATCH /api/customers/:id returns 401 without a staff identity', async () => {
    const res = await app.request(`/api/customers/${customerId}`, {
      method: 'PATCH',
      headers: PUBLIC_HEADERS,
      body: JSON.stringify({ notes: 'sneaky' }),
    });
    expect(res.status).toBe(401);
  });
});
