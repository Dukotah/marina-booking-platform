import { Hono } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';

/**
 * Resource / asset catalog API — staff CRUD for `Resource` (the physical inventory
 * that backs activities: boats, jet skis, kayaks, patios, rooms). Resources are
 * modeled separately from Activities (ARCHITECTURE § 3) so capacity can later be
 * backed by real inventory; this slice is the catalog + the activity assignment
 * (the `ActivityResources` m2m). Every route is staff-only and tenant-scoped via
 * `c.var.db` (RLS).
 *
 * Permissions: reads require `activity:read`, writes `activity:write` — a resource
 * is part of the bookable-catalog configuration, same tier as activities.
 *
 * Mounted by the orchestrator at /api/resources.
 */
export const resources = new Hono<Env>();

resources.use('*', requireStaff);

const resourceInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(160),
  /** Seats/people one unit of this resource holds (e.g. a 10-person pontoon). */
  seatCapacity: z.number().int().positive().default(1),
  /** How many units the operator owns. */
  quantity: z.number().int().nonnegative().default(1),
  /** Units currently out of service (maintenance) — never more than `quantity`. */
  outOfServiceQty: z.number().int().nonnegative().default(0),
  enableTimer: z.boolean().default(false),
  /** Optional home location; must belong to the tenant. */
  locationId: z.string().min(1).nullable().optional(),
  isActive: z.boolean().default(true),
  /** Activities this resource backs (replaces the set). Must belong to the tenant. */
  activityIds: z.array(z.string().min(1)).optional(),
});

const resourceUpdateSchema = resourceInputSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

interface ResourceRow {
  id: string;
  name: string;
  seat_capacity: number;
  quantity: number;
  out_of_service_qty: number;
  enable_timer: boolean;
  is_active: boolean;
  location_id: string | null;
  activities?: Array<{ id: string; name_internal: string }>;
}

function serialize(r: ResourceRow) {
  return {
    id: r.id,
    name: r.name,
    seatCapacity: r.seat_capacity,
    quantity: r.quantity,
    outOfServiceQty: r.out_of_service_qty,
    /** In-service units available to back capacity. */
    availableQty: Math.max(0, r.quantity - r.out_of_service_qty),
    enableTimer: r.enable_timer,
    isActive: r.is_active,
    locationId: r.location_id,
    ...(r.activities
      ? { activities: r.activities.map((a) => ({ id: a.id, name: a.name_internal })) }
      : {}),
  };
}

/**
 * Validate that an optional location + activity-id set all belong to the current
 * tenant (reads go through the RLS client, so a cross-tenant id is simply invisible).
 * Returns an error string for a clean 400, or null when everything checks out.
 */
async function validateRefs(
  db: Env['Variables']['db'],
  locationId: string | null | undefined,
  activityIds: string[] | undefined,
): Promise<string | null> {
  if (locationId) {
    const loc = await db.location.findUnique({ where: { id: locationId }, select: { id: true } });
    if (!loc) return `Location ${locationId} not found`;
  }
  if (activityIds && activityIds.length > 0) {
    const unique = [...new Set(activityIds)];
    const found = await db.activity.findMany({ where: { id: { in: unique } }, select: { id: true } });
    if (found.length !== unique.length) return 'One or more activityIds were not found';
  }
  return null;
}

/**
 * GET /api/resources — list resources for the tenant. Supports `?active=true|false`,
 * `?locationId=`, and a `?q=` name search. Each row includes how many activities it
 * backs.
 */
resources.get('/', async (c) => {
  assertPermission(c.var.auth, 'activity:read');

  const active = c.req.query('active');
  const locationId = c.req.query('locationId')?.trim();
  const q = c.req.query('q')?.trim();

  const rows = await c.var.db.resource.findMany({
    where: {
      ...(active === 'true' ? { is_active: true } : active === 'false' ? { is_active: false } : {}),
      ...(locationId ? { location_id: locationId } : {}),
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
    },
    orderBy: { name: 'asc' },
    include: { _count: { select: { activities: true } } },
  });

  return c.json({
    resources: rows.map((r) => ({ ...serialize(r), activityCount: r._count.activities })),
  });
});

/** GET /api/resources/:id — fetch a single resource with its assigned activities. */
resources.get('/:id', async (c) => {
  assertPermission(c.var.auth, 'activity:read');

  const r = await c.var.db.resource.findUnique({
    where: { id: c.req.param('id') },
    include: { activities: { select: { id: true, name_internal: true }, orderBy: { name_internal: 'asc' } } },
  });
  if (!r) return c.json({ error: 'Resource not found' }, 404);

  return c.json({ resource: serialize(r) });
});

/** POST /api/resources — create a resource, optionally assigning it to activities. */
resources.post('/', async (c) => {
  assertPermission(c.var.auth, 'activity:write');

  const parsed = resourceInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', issues: parsed.error.flatten() }, 400);
  }
  const d = parsed.data;
  if (d.outOfServiceQty > d.quantity) {
    return c.json({ error: 'outOfServiceQty cannot exceed quantity' }, 400);
  }
  const refErr = await validateRefs(c.var.db, d.locationId, d.activityIds);
  if (refErr) return c.json({ error: refErr }, 400);

  const r = await c.var.db.resource.create({
    data: {
      operator_id: c.var.operatorId,
      name: d.name,
      seat_capacity: d.seatCapacity,
      quantity: d.quantity,
      out_of_service_qty: d.outOfServiceQty,
      enable_timer: d.enableTimer,
      is_active: d.isActive,
      location_id: d.locationId ?? null,
      ...(d.activityIds && d.activityIds.length > 0
        ? { activities: { connect: d.activityIds.map((id) => ({ id })) } }
        : {}),
    },
    include: { activities: { select: { id: true, name_internal: true } } },
  });

  return c.json({ resource: serialize(r) }, 201);
});

/** PATCH /api/resources/:id — update fields and/or replace the activity assignment. */
resources.patch('/:id', async (c) => {
  assertPermission(c.var.auth, 'activity:write');

  const id = c.req.param('id');
  const parsed = resourceUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', issues: parsed.error.flatten() }, 400);
  }

  const existing = await c.var.db.resource.findUnique({ where: { id } });
  if (!existing) return c.json({ error: 'Resource not found' }, 404);

  const d = parsed.data;
  // Validate the resulting quantity/out-of-service invariant against the merged state.
  const nextQuantity = d.quantity ?? existing.quantity;
  const nextOos = d.outOfServiceQty ?? existing.out_of_service_qty;
  if (nextOos > nextQuantity) {
    return c.json({ error: 'outOfServiceQty cannot exceed quantity' }, 400);
  }
  const refErr = await validateRefs(c.var.db, d.locationId, d.activityIds);
  if (refErr) return c.json({ error: refErr }, 400);

  const r = await c.var.db.resource.update({
    where: { id },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.seatCapacity !== undefined ? { seat_capacity: d.seatCapacity } : {}),
      ...(d.quantity !== undefined ? { quantity: d.quantity } : {}),
      ...(d.outOfServiceQty !== undefined ? { out_of_service_qty: d.outOfServiceQty } : {}),
      ...(d.enableTimer !== undefined ? { enable_timer: d.enableTimer } : {}),
      ...(d.isActive !== undefined ? { is_active: d.isActive } : {}),
      ...(d.locationId !== undefined ? { location_id: d.locationId } : {}),
      ...(d.activityIds !== undefined
        ? { activities: { set: d.activityIds.map((aid) => ({ id: aid })) } }
        : {}),
    },
    include: { activities: { select: { id: true, name_internal: true } } },
  });

  return c.json({ resource: serialize(r) });
});

/**
 * DELETE /api/resources/:id — soft-delete (deactivate) by default so assignments and
 * history are preserved. `?hard=true` removes the row entirely (the m2m join rows go
 * with it; activities themselves are untouched).
 */
resources.delete('/:id', async (c) => {
  assertPermission(c.var.auth, 'activity:write');

  const id = c.req.param('id');
  const existing = await c.var.db.resource.findUnique({ where: { id } });
  if (!existing) return c.json({ error: 'Resource not found' }, 404);

  if (c.req.query('hard') === 'true') {
    await c.var.db.resource.delete({ where: { id } });
    return c.json({ deleted: true, id });
  }

  const r = await c.var.db.resource.update({ where: { id }, data: { is_active: false } });
  return c.json({ resource: serialize(r), deactivated: true });
});
