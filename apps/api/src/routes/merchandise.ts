import { Hono } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';

/**
 * Merchandise catalog API — staff CRUD for `MerchandiseItem` (retail/add-on
 * inventory sold at the register, e.g. life jackets, drinks, fuel). Every route
 * is staff-only and tenant-scoped via `c.var.db` (RLS).
 *
 * Permissions: reads require `pos:operate` (so register staff can browse stock);
 * writes require `activity:write` (catalog management is a manager/admin task).
 *
 * Mounted by the orchestrator at /api/merchandise.
 */
export const merchandise = new Hono<Env>();

merchandise.use('*', requireStaff);

/** Create/update payload for a MerchandiseItem. Prices/costs are integer cents. */
const merchandiseInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(160),
  category: z.string().trim().min(1, 'Category is required').max(80),
  cost_cents: z.number().int().nonnegative('cost_cents must be >= 0').default(0),
  on_hand_qty: z.number().int().nonnegative().nullable().optional(),
  reorder_alert_qty: z.number().int().nonnegative().nullable().optional(),
  is_active: z.boolean().default(true),
});

/** Partial payload for PATCH — every field optional, but at least one required. */
const merchandiseUpdateSchema = merchandiseInputSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

function serialize(item: {
  id: string;
  name: string;
  category: string;
  cost_cents: number;
  on_hand_qty: number | null;
  reorder_alert_qty: number | null;
  is_active: boolean;
}) {
  const low =
    item.on_hand_qty !== null &&
    item.reorder_alert_qty !== null &&
    item.on_hand_qty <= item.reorder_alert_qty;
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    costCents: item.cost_cents,
    onHandQty: item.on_hand_qty,
    reorderAlertQty: item.reorder_alert_qty,
    isActive: item.is_active,
    lowStock: low,
  };
}

/**
 * GET /api/merchandise — list merchandise for the tenant. Supports `?category=`
 * and `?active=true|false` filters and a `?q=` name search.
 */
merchandise.get('/', async (c) => {
  assertPermission(c.var.auth, 'pos:operate');

  const category = c.req.query('category')?.trim();
  const active = c.req.query('active');
  const q = c.req.query('q')?.trim();

  const items = await c.var.db.merchandiseItem.findMany({
    where: {
      ...(category ? { category } : {}),
      ...(active === 'true' ? { is_active: true } : active === 'false' ? { is_active: false } : {}),
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
    },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  });

  return c.json({ merchandise: items.map(serialize) });
});

/** GET /api/merchandise/:id — fetch a single item. */
merchandise.get('/:id', async (c) => {
  assertPermission(c.var.auth, 'pos:operate');

  const item = await c.var.db.merchandiseItem.findUnique({
    where: { id: c.req.param('id') },
  });
  if (!item) return c.json({ error: 'Merchandise item not found' }, 404);

  return c.json({ merchandise: serialize(item) });
});

/** POST /api/merchandise — create a new item. */
merchandise.post('/', async (c) => {
  assertPermission(c.var.auth, 'activity:write');

  const body = await c.req.json().catch(() => null);
  const parsed = merchandiseInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', issues: parsed.error.flatten() }, 400);
  }

  const item = await c.var.db.merchandiseItem.create({
    data: {
      operator_id: c.var.operatorId,
      name: parsed.data.name,
      category: parsed.data.category,
      cost_cents: parsed.data.cost_cents,
      on_hand_qty: parsed.data.on_hand_qty ?? null,
      reorder_alert_qty: parsed.data.reorder_alert_qty ?? null,
      is_active: parsed.data.is_active,
    },
  });

  return c.json({ merchandise: serialize(item) }, 201);
});

/** PATCH /api/merchandise/:id — update an existing item. */
merchandise.patch('/:id', async (c) => {
  assertPermission(c.var.auth, 'activity:write');

  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = merchandiseUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', issues: parsed.error.flatten() }, 400);
  }

  const existing = await c.var.db.merchandiseItem.findUnique({ where: { id } });
  if (!existing) return c.json({ error: 'Merchandise item not found' }, 404);

  const d = parsed.data;
  const item = await c.var.db.merchandiseItem.update({
    where: { id },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.category !== undefined ? { category: d.category } : {}),
      ...(d.cost_cents !== undefined ? { cost_cents: d.cost_cents } : {}),
      ...(d.on_hand_qty !== undefined ? { on_hand_qty: d.on_hand_qty } : {}),
      ...(d.reorder_alert_qty !== undefined ? { reorder_alert_qty: d.reorder_alert_qty } : {}),
      ...(d.is_active !== undefined ? { is_active: d.is_active } : {}),
    },
  });

  return c.json({ merchandise: serialize(item) });
});

/**
 * DELETE /api/merchandise/:id — soft-delete (deactivate) the item so historical
 * sale references remain intact. Pass `?hard=true` to remove the row entirely.
 */
merchandise.delete('/:id', async (c) => {
  assertPermission(c.var.auth, 'activity:write');

  const id = c.req.param('id');
  const existing = await c.var.db.merchandiseItem.findUnique({ where: { id } });
  if (!existing) return c.json({ error: 'Merchandise item not found' }, 404);

  if (c.req.query('hard') === 'true') {
    await c.var.db.merchandiseItem.delete({ where: { id } });
    return c.json({ deleted: true, id });
  }

  const item = await c.var.db.merchandiseItem.update({
    where: { id },
    data: { is_active: false },
  });
  return c.json({ merchandise: serialize(item), deactivated: true });
});
