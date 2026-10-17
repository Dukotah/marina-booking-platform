/**
 * Packages API — sellable activity/rate bundles.
 *
 *   GET    /                 public — list active, online-visible packages (catalog)
 *   GET    /:id              public — price a single package
 *   GET    /manage           staff  — list all packages (activity:read)
 *   POST   /                 staff  — create a package + its items (activity:write)
 *   PATCH  /:id              staff  — update a package + replace its items (activity:write)
 *   DELETE /:id              staff  — delete a package + its items (activity:write)
 *
 * All data access is tenant-scoped by RLS. Pricing/shaping lives in
 * services/packages.ts. Mounted by the orchestrator at /api/packages.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import { withTenant } from '@marina/database';
import { listPublicPackages, getPricedPackage, PackageError } from '../services/packages.js';

export const packages = new Hono<Env>();

/** GET /api/packages — PUBLIC catalog of active, online-visible packages. */
packages.get('/', async (c) => {
  const rows = await listPublicPackages(c.var.operatorId);
  return c.json({ packages: rows });
});

/**
 * GET /api/packages/manage — staff view (all statuses).
 * Registered before /:id so "manage" isn't treated as an id.
 */
packages.get('/manage', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:read');
  const rows = await c.var.db.package.findMany({
    orderBy: { sort_index: 'asc' },
    include: {
      items: {
        orderBy: { sort_index: 'asc' },
        include: {
          activity: { select: { name_external: true } },
          rate: { select: { name_external: true, price_cents: true } },
        },
      },
    },
  });
  return c.json({ packages: rows });
});

/** GET /api/packages/:id — PUBLIC priced detail for one package. */
packages.get('/:id', async (c) => {
  try {
    const pkg = await getPricedPackage(c.var.operatorId, c.req.param('id'));
    return c.json({ package: pkg });
  } catch (err) {
    if (err instanceof PackageError) {
      return c.json({ error: err.message, code: err.code }, err.status as 404);
    }
    throw err;
  }
});

const createSchema = z.object({
  nameInternal: z.string().trim().min(1).max(160),
  nameExternal: z.string().trim().min(1).max(160),
  descriptionHtml: z.string().trim().max(10_000).optional(),
  priceCents: z.number().int().positive('Package price must be a positive number of cents'),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  visibleOnline: z.boolean().default(true),
  sortIndex: z.number().int().nonnegative().default(0),
  items: z
    .array(
      z.object({
        activityId: z.string().min(1),
        rateId: z.string().min(1),
        quantity: z.number().int().positive().default(1),
        sortIndex: z.number().int().nonnegative().default(0),
      }),
    )
    .min(1, 'A package needs at least one item'),
});

/** POST /api/packages — staff create a package + its items. */
packages.post('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:write');
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const operatorId = c.var.operatorId;

  // Validate each item's rate belongs to its activity (and to this tenant, via RLS).
  for (const item of input.items) {
    const rate = await c.var.db.rate.findUnique({ where: { id: item.rateId } });
    if (!rate || rate.activity_id !== item.activityId) {
      return c.json({ error: `Rate ${item.rateId} not found for activity ${item.activityId}` }, 400);
    }
  }

  // The Package and its items share operator_id across three composite FKs, so
  // Prisma can't disambiguate a nested `items.create`. Create the parent, then the
  // items flatly (explicit scalars) inside one tenant transaction.
  const created = await withTenant(operatorId, async (tx) => {
    const pkg = await tx.package.create({
      data: {
        operator_id: operatorId,
        name_internal: input.nameInternal,
        name_external: input.nameExternal,
        description_html: input.descriptionHtml ?? null,
        price_cents: input.priceCents,
        status: input.status,
        visible_online: input.visibleOnline,
        sort_index: input.sortIndex,
      },
    });
    await tx.packageItem.createMany({
      data: input.items.map((it) => ({
        operator_id: operatorId,
        package_id: pkg.id,
        activity_id: it.activityId,
        rate_id: it.rateId,
        quantity: it.quantity,
        sort_index: it.sortIndex,
      })),
    });
    const items = await tx.packageItem.findMany({ where: { package_id: pkg.id } });
    return { ...pkg, items };
  });

  return c.json({ package: created }, 201);
});

const updateSchema = createSchema;

/**
 * PATCH /api/packages/:id — staff update a package and REPLACE its item set.
 * Items are replaced wholesale (delete-then-recreate) inside one tenant
 * transaction: a package's line-up is small and the editor always submits the
 * full list, so a full swap is simpler and race-free versus a diff.
 */
packages.patch('/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:write');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const operatorId = c.var.operatorId;

  const existing = await c.var.db.package.findUnique({ where: { id } });
  if (!existing) {
    return c.json({ error: 'Package not found' }, 404);
  }

  // Validate each item's rate belongs to its activity (and to this tenant, via RLS).
  for (const item of input.items) {
    const rate = await c.var.db.rate.findUnique({ where: { id: item.rateId } });
    if (!rate || rate.activity_id !== item.activityId) {
      return c.json({ error: `Rate ${item.rateId} not found for activity ${item.activityId}` }, 400);
    }
  }

  const updated = await withTenant(operatorId, async (tx) => {
    const pkg = await tx.package.update({
      where: { id },
      data: {
        name_internal: input.nameInternal,
        name_external: input.nameExternal,
        description_html: input.descriptionHtml ?? null,
        price_cents: input.priceCents,
        status: input.status,
        visible_online: input.visibleOnline,
        sort_index: input.sortIndex,
      },
    });
    await tx.packageItem.deleteMany({ where: { package_id: id } });
    await tx.packageItem.createMany({
      data: input.items.map((it) => ({
        operator_id: operatorId,
        package_id: id,
        activity_id: it.activityId,
        rate_id: it.rateId,
        quantity: it.quantity,
        sort_index: it.sortIndex,
      })),
    });
    const items = await tx.packageItem.findMany({ where: { package_id: id } });
    return { ...pkg, items };
  });

  return c.json({ package: updated });
});

/** DELETE /api/packages/:id — staff delete a package (items cascade). */
packages.delete('/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:write');
  const id = c.req.param('id');
  const existing = await c.var.db.package.findUnique({ where: { id } });
  if (!existing) {
    return c.json({ error: 'Package not found' }, 404);
  }
  // PackageItem has onDelete: Cascade on its package relation, so deleting the
  // parent clears its lines in one statement.
  await c.var.db.package.delete({ where: { id } });
  return c.json({ ok: true });
});
