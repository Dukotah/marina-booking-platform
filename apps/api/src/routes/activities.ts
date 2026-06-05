import { Hono } from 'hono';
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
    where: { status: 'ACTIVE', visible_online: true },
    orderBy: { sort_index: 'asc' },
    include: {
      rates: {
        where: { is_active: true, internal_only: false },
        orderBy: { sort_index: 'asc' },
      },
    },
  });

  const catalog = rows.map((a) => ({
    id: a.id,
    name: a.name_external,
    category: a.category,
    maxParticipants: a.max_participants,
    color: a.color,
    photoUrls: a.photo_urls,
    waiverRequired: a.waiver_required,
    fromPriceCents:
      a.rates.find((r) => r.is_from_price)?.price_cents ??
      a.rates.reduce<number | null>((min, r) => (min === null ? r.price_cents : Math.min(min, r.price_cents)), null),
    rates: a.rates.map((r) => ({
      id: r.id,
      name: r.name_external,
      priceCents: r.price_cents,
      durationMinutes: r.duration_minutes,
    })),
  }));

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
    where: { id, status: 'ACTIVE', visible_online: true },
    include: {
      rates: {
        where: { is_active: true, internal_only: false },
        orderBy: { sort_index: 'asc' },
      },
    },
  });

  if (!row) {
    return c.json({ error: 'Activity not found' }, 404);
  }

  const fromPriceCents =
    row.rates.find((r) => r.is_from_price)?.price_cents ??
    row.rates.reduce<number | null>(
      (min, r) => (min === null ? r.price_cents : Math.min(min, r.price_cents)),
      null,
    );

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
      fromPriceCents,
      rates: row.rates.map((r) => ({
        id: r.id,
        name: r.name_external,
        priceCents: r.price_cents,
        durationMinutes: r.duration_minutes,
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

