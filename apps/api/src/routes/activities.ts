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
 * Demonstrates the auth + RBAC path.
 */
activities.get('/manage', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:read');
  const rows = await c.var.db.activity.findMany({
    orderBy: { sort_index: 'asc' },
    include: { rates: { orderBy: { sort_index: 'asc' } } },
  });
  return c.json({ activities: rows });
});
