/**
 * Add-ons / upsells API — the operator's checkout extras (life jackets, coolers,
 * tubes, photo packages, fuel).
 *
 *   GET    /?activityId=&guests=   public — what a guest may add to this booking
 *   GET    /manage                 staff  — the whole catalog (activity:read)
 *   POST   /                       staff  — create (activity:write)
 *   PATCH  /:id                    staff  — update (activity:write)
 *   DELETE /:id                    staff  — delete, or retire if it has sold
 *
 * All logic and data access lives in services/addons.ts; this file is validation
 * and serialization only. Every read is tenant-scoped by RLS.
 *
 * Mounted by the orchestrator at /api/addons — see the hand-off report for the
 * exact `app.ts` line. Deliberately NOT mounted here.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import {
  AddOnError,
  createAddOn,
  deleteAddOn,
  listAllAddOns,
  offerAddOns,
  updateAddOn,
  type AddOnDefinition,
  type AddOnInput,
  type OfferedAddOn,
} from '../services/addons.js';

export const addons = new Hono<Env>();

/**
 * Map a service error onto a clean HTTP response. Anything that is not an
 * AddOnError is a bug, not a user-facing failure, so it is rethrown to the
 * app-level handler rather than flattened into a 400 that hides it.
 */
function fail(err: unknown): { error: string; code: string; status: number } {
  if (err instanceof AddOnError) {
    return { error: err.message, code: err.code, status: err.status };
  }
  throw err;
}

/** The staff-facing JSON shape (camelCase, mirroring the rest of the API). */
function serialize(def: AddOnDefinition) {
  return {
    id: def.id,
    activityId: def.activityId,
    name: def.name,
    description: def.description,
    priceCents: def.priceCents,
    basis: def.basis,
    maxPerBooking: def.maxPerBooking,
    stockTotal: def.stockTotal,
    stockSold: def.stockSold,
    isActive: def.isActive,
    sortIndex: def.sortIndex,
  };
}

/** The customer-facing shape: the definition plus the resolved stock ceiling. */
function serializeOffer(offer: OfferedAddOn) {
  return {
    ...serialize(offer),
    remainingStock: offer.remainingStock,
    maxSelectable: offer.maxSelectable,
  };
}

const offerQuerySchema = z.object({
  activityId: z.string().min(1, 'activityId is required'),
  /** Party size, so a per-guest add-on can price and stock-check against it. */
  guests: z.coerce.number().int().positive().max(500).default(1),
});

/**
 * GET /api/addons — PUBLIC. What this activity offers a party of this size.
 *
 * `maxSelectable` is authoritative for the UI's stepper, but never for the
 * money: the booking path re-reads and re-prices every selection server-side.
 */
addons.get('/', async (c) => {
  const parsed = offerQuerySchema.safeParse({
    activityId: c.req.query('activityId'),
    guests: c.req.query('guests') ?? 1,
  });
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  const offers = await offerAddOns(
    c.var.operatorId,
    parsed.data.activityId,
    parsed.data.guests,
  );
  return c.json({ addOns: offers.map(serializeOffer) });
});

/**
 * GET /api/addons/manage — staff view of the whole catalog, retired ones
 * included. Registered before /:id so "manage" is not read as an id.
 */
addons.get('/manage', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:read');
  const rows = await listAllAddOns(c.var.operatorId);
  return c.json({ addOns: rows.map(serialize) });
});

/**
 * Create/update payload. `priceCents` is integer cents — the platform never
 * accepts a float for money, so a dollars field is the UI's job to convert.
 * `activityId: null` means the add-on is offered on every activity.
 */
const addOnInputSchema = z.object({
  activityId: z.string().min(1).nullable().default(null),
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(500).nullable().default(null),
  priceCents: z.number().int().nonnegative('priceCents must be >= 0'),
  basis: z.enum(['PER_GUEST', 'PER_BOOKING']).default('PER_BOOKING'),
  maxPerBooking: z.number().int().positive().nullable().default(null),
  stockTotal: z.number().int().nonnegative().nullable().default(null),
  isActive: z.boolean().default(true),
  sortIndex: z.number().int().nonnegative().default(0),
});

/** POST /api/addons — staff create. */
addons.post('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:write');
  const body = await c.req.json().catch(() => null);
  const parsed = addOnInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const created = await createAddOn(c.var.operatorId, parsed.data satisfies AddOnInput);
    return c.json({ addOn: serialize(created) }, 201);
  } catch (err) {
    const mapped = fail(err);
    return c.json({ error: mapped.error, code: mapped.code }, mapped.status as 400);
  }
});

/**
 * PATCH /api/addons/:id — staff update.
 *
 * A full replacement of the definition (the settings editor always sends every
 * field), so the schema is the same one create uses. `stockSold` is absent by
 * design: it is a ledger of what is on real orders and only the booking and
 * cancellation paths may move it.
 */
addons.patch('/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:write');
  const body = await c.req.json().catch(() => null);
  const parsed = addOnInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const updated = await updateAddOn(
      c.var.operatorId,
      c.req.param('id'),
      parsed.data satisfies AddOnInput,
    );
    return c.json({ addOn: serialize(updated) });
  } catch (err) {
    const mapped = fail(err);
    return c.json({ error: mapped.error, code: mapped.code }, mapped.status as 400);
  }
});

/**
 * DELETE /api/addons/:id — staff delete.
 *
 * An add-on that has never sold is deleted; one that appears on an order is
 * retired instead (`isActive: false`), because its order items are what a
 * receipt, a refund and a tax report are read from. The response says which
 * happened so the UI can tell the operator the truth.
 */
addons.delete('/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:write');
  try {
    const result = await deleteAddOn(c.var.operatorId, c.req.param('id'));
    return c.json({ deleted: result.deleted, retired: !result.deleted });
  } catch (err) {
    const mapped = fail(err);
    return c.json({ error: mapped.error, code: mapped.code }, mapped.status as 404);
  }
});
