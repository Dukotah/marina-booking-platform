import { Hono } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';

export const activities = new Hono<Env>();

/**
 * GET /api/activities — public booking catalog for the resolved tenant.
 * Returns active, online-visible activities with their bookable (non-internal)
 * rates. Scoped automatically by RLS via c.var.db.
 */
activities.get('/', async (c) => {
  const rows = await c.var.db.activity.findMany({
    // Per-channel visibility (Singenuity §1): the online catalog is the "display"
    // surface, so it also excludes anything flagged hide_from_display.
    where: { status: 'ACTIVE', visible_online: true, hide_from_display: false },
    orderBy: { sort_index: 'asc' },
    include: {
      rates: {
        where: { is_active: true, internal_only: false },
        orderBy: { sort_index: 'asc' },
      },
    },
  });

  const catalog = rows.map((a) => {
    // hide_price: list the activity but suppress pricing ("call for price").
    const fromPriceCents = a.hide_price
      ? null
      : (a.rates.find((r) => r.is_from_price)?.price_cents ??
        a.rates.reduce<number | null>(
          (min, r) => (min === null ? r.price_cents : Math.min(min, r.price_cents)),
          null,
        ));
    return {
      id: a.id,
      name: a.name_external,
      category: a.category,
      maxParticipants: a.max_participants,
      color: a.color,
      photoUrls: a.photo_urls,
      waiverRequired: a.waiver_required,
      hidePrice: a.hide_price,
      fromPriceCents,
      rates: a.rates.map((r) => ({
        id: r.id,
        name: r.name_external,
        priceCents: r.price_cents,
        durationMinutes: r.duration_minutes,
      })),
    };
  });

  return c.json({ activities: catalog });
});

/**
 * GET /api/activities/manage — staff view (includes inactive + internal rates).
 * Must be registered before /:id so Hono doesn't treat "manage" as an id param.
 */
activities.get('/manage', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:read');
  const rows = await c.var.db.activity.findMany({
    orderBy: { sort_index: 'asc' },
    include: { rates: { orderBy: { sort_index: 'asc' } } },
  });
  return c.json({ activities: rows });
});

/**
 * GET /api/activities/:id — public detail for a single activity (booking page).
 * Returns the same fields as the catalog plus description and reschedule policy.
 */
activities.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.var.db.activity.findFirst({
    where: { id, status: 'ACTIVE', visible_online: true, hide_from_display: false },
    include: {
      rates: {
        where: { is_active: true, internal_only: false },
        orderBy: { sort_index: 'asc' },
      },
      upsells: {
        where: { is_active: true },
        orderBy: { sort_index: 'asc' },
      },
    },
  });

  if (!row) {
    return c.json({ error: 'Activity not found' }, 404);
  }

  const fromPriceCents = row.hide_price
    ? null
    : (row.rates.find((r) => r.is_from_price)?.price_cents ??
      row.rates.reduce<number | null>(
        (min, r) => (min === null ? r.price_cents : Math.min(min, r.price_cents)),
        null,
      ));

  return c.json({
    activity: {
      id: row.id,
      name: row.name_external,
      category: row.category,
      minParticipants: row.min_participants,
      maxParticipants: row.max_participants,
      color: row.color,
      photoUrls: row.photo_urls,
      waiverRequired: row.waiver_required,
      descriptionHtml: row.description_html,
      selfRescheduleHours: row.self_reschedule_hours,
      hidePrice: row.hide_price,
      fromPriceCents,
      rates: row.rates.map((r) => ({
        id: r.id,
        name: r.name_external,
        priceCents: r.price_cents,
        durationMinutes: r.duration_minutes,
      })),
      // Optional add-ons offered at checkout (Singenuity §1 package upsells).
      upsells: row.upsells.map((u) => ({
        id: u.id,
        name: u.name,
        description: u.description,
        priceCents: u.price_cents,
      })),
    },
  });
});

/**
 * GET /api/activities/:id/availability — availability for one activity on one day.
 * Proxies the canonical /api/availability endpoint with the activityId from the path.
 * URL shape matches the customer portal's lib/api.ts `getAvailability` call.
 */
activities.get('/:id/availability', async (c) => {
  const activityId = c.req.param('id');
  const date = c.req.query('date');
  if (!date) {
    return c.json({ error: 'date query param is required (YYYY-MM-DD)' }, 400);
  }
  // Delegate to the shared availability service rather than duplicating logic.
  const { getDayAvailability, AvailabilityError } = await import('../services/availability.js');
  try {
    const result = await getDayAvailability(c.var.db, { activityId, date });
    // Re-shape to match what the web's lib/api.ts expects for AvailabilityDay.
    return c.json({
      activityId: result.activityId,
      date: result.date,
      slots: result.timeslots.map((t) => ({
        timeslotId: t.id,
        datetime: t.datetime,
        capacityTotal: t.capacityTotal,
        capacityBooked: t.capacityBooked,
        capacityRemaining: t.capacityRemaining,
        status: t.status,
      })),
    });
  } catch (err) {
    if (err instanceof AvailabilityError) {
      return c.json({ error: err.message }, err.status as 400 | 404);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Package upsells — optional per-activity add-ons offered at checkout.
// (Public checkout reads them via GET /:id above; these manage them.)
// ---------------------------------------------------------------------------

/** GET /api/activities/:id/upsells — staff list all upsells for an activity. */
activities.get('/:id/upsells', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:read');
  const activityId = c.req.param('id');
  const rows = await c.var.db.packageUpsell.findMany({
    where: { activity_id: activityId },
    orderBy: { sort_index: 'asc' },
  });
  return c.json({ upsells: rows });
});

const upsellSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(160),
  description: z.string().trim().max(1000).optional(),
  priceCents: z.number().int().nonnegative('priceCents must be >= 0'),
  isActive: z.boolean().default(true),
  sortIndex: z.number().int().nonnegative().default(0),
});

/** POST /api/activities/:id/upsells — staff attach an add-on to an activity. */
activities.post('/:id/upsells', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:write');
  const activityId = c.req.param('id');
  const activity = await c.var.db.activity.findUnique({ where: { id: activityId } });
  if (!activity) return c.json({ error: 'Activity not found' }, 404);

  const body = await c.req.json().catch(() => null);
  const parsed = upsellSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', issues: parsed.error.flatten() }, 400);
  }
  const upsell = await c.var.db.packageUpsell.create({
    data: {
      operator_id: c.var.operatorId,
      activity_id: activityId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      price_cents: parsed.data.priceCents,
      is_active: parsed.data.isActive,
      sort_index: parsed.data.sortIndex,
    },
  });
  return c.json({ upsell }, 201);
});

/** DELETE /api/activities/:id/upsells/:upsellId — staff remove an add-on. */
activities.delete('/:id/upsells/:upsellId', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:write');
  const upsellId = c.req.param('upsellId');
  const existing = await c.var.db.packageUpsell.findUnique({ where: { id: upsellId } });
  if (!existing || existing.activity_id !== c.req.param('id')) {
    return c.json({ error: 'Upsell not found' }, 404);
  }
  await c.var.db.packageUpsell.delete({ where: { id: upsellId } });
  return c.json({ deleted: true, id: upsellId });
});

