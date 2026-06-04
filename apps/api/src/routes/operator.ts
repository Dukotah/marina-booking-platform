import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { Prisma, withTenant, type Operator as OperatorRow, type TenantClient } from '@marina/database';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';

/**
 * Operator settings + onboarding API.
 *
 * Mounted by the orchestrator under `/api/operator`. The tenant is already
 * resolved by `tenantMiddleware` (every request carries `c.var.operatorId` and
 * the RLS-scoped `c.var.db`), so the operator row for THIS tenant is fetched with
 * an unfiltered `findFirst` — RLS guarantees only the current tenant is visible.
 *
 * All routes require `operator:manage` EXCEPT `GET /public`, which exposes only the
 * white-label branding the customer-facing web app needs and is intentionally
 * unauthenticated.
 */
export const operator = new Hono<Env>();

// --- Helpers --------------------------------------------------------------

/** A 400 with structured Zod issues. Keeps validation errors machine-readable. */
function badRequest(c: Context<Env>, error: z.ZodError) {
  return c.json(
    {
      error: 'Validation failed',
      issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    },
    400,
  );
}

/** Hex color (#rgb or #rrggbb). */
const hexColor = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'must be a hex color, e.g. #0ea5e9');

/**
 * IANA timezone validation. Uses the host Intl database so we never persist a
 * bogus zone that would break time rendering downstream.
 */
const timezone = z
  .string()
  .trim()
  .min(1)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a valid IANA timezone, e.g. America/Los_Angeles' },
  );

// --- Schemas --------------------------------------------------------------

/** PATCH / — branding, contact, policy, and timezone settings. All optional. */
const operatorUpdateSchema = z
  .object({
    name_external: z.string().trim().min(1).max(160),
    name_internal: z.string().trim().min(1).max(160),
    website: z.string().trim().url().max(2048).nullable(),
    phone: z.string().trim().max(32).nullable(),
    timezone,
    country: z.string().trim().length(2, 'country must be a 2-letter ISO code'),
    logo_dark_url: z.string().trim().url().max(2048).nullable(),
    logo_light_url: z.string().trim().url().max(2048).nullable(),
    brand_color: hexColor,
    legal_adult_age: z.number().int().min(13).max(25),
    custom_domain: z.string().trim().min(1).max(253).toLowerCase().nullable(),
  })
  .partial()
  .strict();

/** PUT /integrations/:key — upsert a per-operator integration config. */
const integrationUpsertSchema = z
  .object({
    enabled: z.boolean().default(false),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const locationCreateSchema = z
  .object({
    name: z.string().trim().min(1, 'name is required').max(160),
    address: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    state: z.string().trim().max(64).nullable().optional(),
    zip: z.string().trim().max(16).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    timezone: timezone.nullable().optional(),
    is_default: z.boolean().default(false),
    is_active: z.boolean().default(true),
  })
  .strict();

const locationUpdateSchema = locationCreateSchema.partial().strict();

// --- Serializers ----------------------------------------------------------

/** Full settings view for the admin dashboard. */
function serializeOperator(o: OperatorRow) {
  return {
    id: o.id,
    slug: o.slug,
    custom_domain: o.custom_domain,
    name_internal: o.name_internal,
    name_external: o.name_external,
    location_code: o.location_code,
    website: o.website,
    phone: o.phone,
    timezone: o.timezone,
    country: o.country,
    logo_dark_url: o.logo_dark_url,
    logo_light_url: o.logo_light_url,
    brand_color: o.brand_color,
    legal_adult_age: o.legal_adult_age,
    plan: o.plan,
    is_active: o.is_active,
    created_at: o.created_at,
    updated_at: o.updated_at,
  };
}

/** Loads the current tenant's operator row or returns null. */
async function loadOperator(db: TenantClient) {
  // RLS scopes this to the current tenant; findFirst returns that single row.
  return db.operator.findFirst();
}

// --- Public branding ------------------------------------------------------

/**
 * GET /public — unauthenticated white-label branding for the resolved tenant.
 * Consumed by the customer web app to theme the booking portal. Exposes ONLY
 * presentation data — never internal names, billing, or policy internals.
 */
operator.get('/public', async (c) => {
  const o = await loadOperator(c.var.db);
  if (!o) return c.json({ error: 'Operator not found' }, 404);

  return c.json({
    slug: o.slug,
    name: o.name_external,
    brand_color: o.brand_color,
    logo_dark_url: o.logo_dark_url,
    logo_light_url: o.logo_light_url,
    timezone: o.timezone,
    website: o.website,
    phone: o.phone,
  });
});

// --- Full settings --------------------------------------------------------

/** GET / — full operator settings (admin). */
operator.get('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const o = await loadOperator(c.var.db);
  if (!o) return c.json({ error: 'Operator not found' }, 404);
  return c.json({ operator: serializeOperator(o) });
});

/** PATCH / — update branding, contact, policy, and timezone settings. */
operator.patch('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');

  const body = await c.req.json().catch(() => null);
  const parsed = operatorUpdateSchema.safeParse(body);
  if (!parsed.success) return badRequest(c, parsed.error);
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  const existing = await loadOperator(c.var.db);
  if (!existing) return c.json({ error: 'Operator not found' }, 404);

  try {
    const updated = await c.var.db.operator.update({
      where: { id: existing.id },
      data: parsed.data,
    });
    return c.json({ operator: serializeOperator(updated) });
  } catch (err) {
    // Unique-constraint collision (custom_domain) is the only expected failure.
    if (isUniqueViolation(err)) {
      return c.json({ error: 'That custom domain is already in use' }, 409);
    }
    throw err;
  }
});

// --- Integrations ---------------------------------------------------------

/** GET /integrations/:key — read one integration's config (admin). */
operator.get('/integrations/:key', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const key = c.req.param('key').trim().toLowerCase();

  const integration = await c.var.db.integration.findFirst({ where: { key } });
  if (!integration) {
    // Not yet configured — return a disabled default so the UI can render a form.
    return c.json({ integration: { key, enabled: false, config: {} } });
  }
  return c.json({
    integration: {
      id: integration.id,
      key: integration.key,
      enabled: integration.enabled,
      config: integration.config,
      created_at: integration.created_at,
      updated_at: integration.updated_at,
    },
  });
});

/** PUT /integrations/:key — upsert an integration config by key (admin). */
operator.put('/integrations/:key', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const key = c.req.param('key').trim().toLowerCase();
  if (!key) return c.json({ error: 'Integration key is required' }, 400);

  const body = await c.req.json().catch(() => null);
  const parsed = integrationUpsertSchema.safeParse(body);
  if (!parsed.success) return badRequest(c, parsed.error);

  const operatorId = c.var.operatorId;
  const config = parsed.data.config as Prisma.InputJsonValue;
  const integration = await c.var.db.integration.upsert({
    where: { operator_id_key: { operator_id: operatorId, key } },
    create: {
      operator_id: operatorId,
      key,
      enabled: parsed.data.enabled,
      config,
    },
    update: {
      enabled: parsed.data.enabled,
      config,
    },
  });

  return c.json({
    integration: {
      id: integration.id,
      key: integration.key,
      enabled: integration.enabled,
      config: integration.config,
      created_at: integration.created_at,
      updated_at: integration.updated_at,
    },
  });
});

// --- Locations ------------------------------------------------------------

/** GET /locations — list the tenant's locations (admin). */
operator.get('/locations', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const locations = await c.var.db.location.findMany({
    orderBy: [{ is_default: 'desc' }, { name: 'asc' }],
  });
  return c.json({ locations });
});

/** POST /locations — create a location (admin). */
operator.post('/locations', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');

  const body = await c.req.json().catch(() => null);
  const parsed = locationCreateSchema.safeParse(body);
  if (!parsed.success) return badRequest(c, parsed.error);

  const data = parsed.data;
  const operatorId = c.var.operatorId;

  // A tenant has at most one default location: creating a new default demotes the
  // rest. withTenant runs the multi-step work atomically with RLS scoping applied
  // to the interactive transaction (the extended client's per-op wrapping does not
  // cover an interactive $transaction, so we must use withTenant here).
  const location = await withTenant(operatorId, async (tx) => {
    if (data.is_default) {
      await tx.location.updateMany({
        where: { is_default: true },
        data: { is_default: false },
      });
    }
    return tx.location.create({
      data: {
        operator_id: operatorId,
        name: data.name,
        address: data.address ?? null,
        city: data.city ?? null,
        state: data.state ?? null,
        zip: data.zip ?? null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        timezone: data.timezone ?? null,
        is_default: data.is_default,
        is_active: data.is_active,
      },
    });
  });

  return c.json({ location }, 201);
});

/** PATCH /locations/:id — update a location (admin). */
operator.patch('/locations/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = locationUpdateSchema.safeParse(body);
  if (!parsed.success) return badRequest(c, parsed.error);
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  // RLS scopes this lookup to the tenant; a foreign id simply won't be found.
  const existing = await c.var.db.location.findFirst({ where: { id } });
  if (!existing) return c.json({ error: 'Location not found' }, 404);

  const data = parsed.data;

  const location = await withTenant(c.var.operatorId, async (tx) => {
    if (data.is_default === true) {
      await tx.location.updateMany({
        where: { is_default: true, id: { not: id } },
        data: { is_default: false },
      });
    }
    return tx.location.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.address !== undefined ? { address: data.address } : {}),
        ...(data.city !== undefined ? { city: data.city } : {}),
        ...(data.state !== undefined ? { state: data.state } : {}),
        ...(data.zip !== undefined ? { zip: data.zip } : {}),
        ...(data.latitude !== undefined ? { latitude: data.latitude } : {}),
        ...(data.longitude !== undefined ? { longitude: data.longitude } : {}),
        ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
        ...(data.is_default !== undefined ? { is_default: data.is_default } : {}),
        ...(data.is_active !== undefined ? { is_active: data.is_active } : {}),
      },
    });
  });

  return c.json({ location });
});

// --- Internal -------------------------------------------------------------

/** Detects a Prisma P2002 unique-constraint violation by its error code. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}
