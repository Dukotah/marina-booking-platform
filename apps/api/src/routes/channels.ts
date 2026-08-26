/**
 * OTA / affiliate channel API — staff only, no public surface.
 *
 *   GET    /                                 list channels          (operator:manage)
 *   POST   /                                 create a channel       (operator:manage)
 *   PATCH  /:id                              enable / rate / config (operator:manage)
 *   GET    /:id/listings                     what this channel sells (activity:read)
 *   PUT    /:id/listings                     set what it sells      (activity:write)
 *   POST   /:id/push                         publish inventory now  (activity:write)
 *   POST   /:id/pull                         pull + import bookings (order:write)
 *   POST   /:id/sync                         push then pull         (order:write)
 *   GET    /:id/bookings                     imported bookings      (order:read)
 *   POST   /:id/bookings/:ref/cancel         cancel at the partner  (order:write)
 *   GET    /report                           commission report      (report:read)
 *
 *   MOCK-only console controls (docs/LOCAL-FIRST-BUILD.md §4.2):
 *   GET    /:id/mock                         what the marketplace believes
 *   POST   /:id/mock/book                    manufacture a booking on demand
 *   POST   /:id/mock/cancel                  make a guest cancel
 *   POST   /:id/mock/outage                  arm a one-shot partner failure
 *
 * All data access is tenant-scoped by RLS; the driver work lives in
 * services/channels.ts. NOT yet mounted in app.ts — see the report.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import {
  CHANNEL_KINDS,
  ChannelError,
  cancelAtChannel,
  channelCommissionReport,
  channelContext,
  createChannel,
  listChannels,
  listListings,
  pullAndImport,
  pushInventory,
  setListings,
  syncChannel,
  updateChannel,
} from '../services/channels.js';
import { mockBookNow, mockCancelNow, mockForceOutage, mockSnapshot } from '../services/channel-mock.js';

export const channels = new Hono<Env>();

/** Every route here is staff-only; a partner integration is never public. */
channels.use('*', requireStaff);

/** Map a typed service failure onto its HTTP status; rethrow anything else. */
function fail(c: Context<Env>, err: unknown): Response {
  if (err instanceof ChannelError) {
    return c.json({ error: err.message, code: err.code }, err.status as 400);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Reporting — registered before /:id so "report" is not read as a channel id.
// ---------------------------------------------------------------------------

const reportSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/** GET /api/channels/report?from=&to= — what each channel sold and what it cost. */
channels.get('/report', async (c) => {
  assertPermission(c.var.auth, 'report:read');
  const parsed = reportSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  const report = await channelCommissionReport(c.var.operatorId, {
    from: parsed.data.from ? new Date(parsed.data.from) : null,
    to: parsed.data.to ? new Date(parsed.data.to) : null,
  });
  return c.json(report);
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

channels.get('/', async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  return c.json({ channels: await listChannels(c.var.operatorId) });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(CHANNEL_KINDS),
  commissionPercent: z.number().int().min(0).max(100).default(0),
  enabled: z.boolean().default(false),
  config: z.record(z.string(), z.unknown()).default({}),
});

channels.post('/', async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const channel = await createChannel(c.var.operatorId, {
      name: parsed.data.name,
      kind: parsed.data.kind,
      commissionPercent: parsed.data.commissionPercent,
      enabled: parsed.data.enabled,
      config: parsed.data.config,
    });
    return c.json({ channel }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    commissionPercent: z.number().int().min(0).max(100).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

channels.patch('/:id', async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const body = await c.req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const channel = await updateChannel(c.var.operatorId, c.req.param('id'), parsed.data);
    return c.json({ channel });
  } catch (err) {
    return fail(c, err);
  }
});

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

channels.get('/:id/listings', async (c) => {
  assertPermission(c.var.auth, 'activity:read');
  try {
    return c.json({ listings: await listListings(c.var.operatorId, c.req.param('id')) });
  } catch (err) {
    return fail(c, err);
  }
});

const listingsSchema = z.object({
  activityIds: z.array(z.string().min(1)).max(500),
});

/** PUT — the full set this channel sells. Absent activities are deactivated. */
channels.put('/:id/listings', async (c) => {
  assertPermission(c.var.auth, 'activity:write');
  const body = await c.req.json().catch(() => null);
  const parsed = listingsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const listings = await setListings(c.var.operatorId, c.req.param('id'), parsed.data.activityIds);
    return c.json({ listings });
  } catch (err) {
    return fail(c, err);
  }
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

channels.post('/:id/push', async (c) => {
  assertPermission(c.var.auth, 'activity:write');
  try {
    return c.json({ push: await pushInventory(c.var.operatorId, c.req.param('id')) });
  } catch (err) {
    return fail(c, err);
  }
});

const pullSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  since: z.string().datetime().optional(),
});

channels.post('/:id/pull', async (c) => {
  assertPermission(c.var.auth, 'order:write');
  const body = await c.req.json().catch(() => ({}));
  const parsed = pullSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const pull = await pullAndImport(c.var.operatorId, c.req.param('id'), {
      limit: parsed.data.limit,
      since: parsed.data.since ? new Date(parsed.data.since) : null,
    });
    return c.json({ pull });
  } catch (err) {
    return fail(c, err);
  }
});

channels.post('/:id/sync', async (c) => {
  assertPermission(c.var.auth, 'order:write');
  try {
    return c.json(await syncChannel(c.var.operatorId, c.req.param('id')));
  } catch (err) {
    return fail(c, err);
  }
});

// ---------------------------------------------------------------------------
// Imported bookings
// ---------------------------------------------------------------------------

channels.get('/:id/bookings', async (c) => {
  assertPermission(c.var.auth, 'order:read');
  const rows = await c.var.db.channelBooking.findMany({
    where: { channel_id: c.req.param('id') },
    orderBy: { created_at: 'desc' },
    take: 200,
    include: {
      order: { select: { id: true, order_number: true, status: true, total_cents: true } },
    },
  });
  return c.json({ bookings: rows });
});

const cancelSchema = z.object({
  reason: z.string().trim().min(1).max(500).default('Cancelled by the operator'),
});

/** Operator-initiated: cancel our order AND tell the partner. */
channels.post('/:id/bookings/:ref/cancel', async (c) => {
  assertPermission(c.var.auth, 'order:write');
  const body = await c.req.json().catch(() => ({}));
  const parsed = cancelSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const result = await cancelAtChannel(
      c.var.operatorId,
      c.req.param('id'),
      c.req.param('ref'),
      parsed.data.reason,
    );
    return c.json(result);
  } catch (err) {
    return fail(c, err);
  }
});

// ---------------------------------------------------------------------------
// MOCK console controls
// ---------------------------------------------------------------------------

/**
 * The mock controls are the channel half of the Local Console: they let the owner
 * make a marketplace booking appear, make a guest cancel, and make the partner
 * fall over — without waiting for the arrival schedule and without an account.
 * They refuse on any other kind so they cannot be aimed at a real partner.
 */
async function mockCtx(operatorId: string, channelId: string) {
  const ctx = await channelContext(operatorId, channelId);
  if (ctx.kind !== 'MOCK') {
    throw new ChannelError(
      'NOT_A_MOCK_CHANNEL',
      `${ctx.channelName} is a ${ctx.kind} channel; simulation controls only exist for MOCK`,
      409,
    );
  }
  return ctx;
}

channels.get('/:id/mock', async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  try {
    return c.json(await mockSnapshot(await mockCtx(c.var.operatorId, c.req.param('id'))));
  } catch (err) {
    return fail(c, err);
  }
});

const mockBookSchema = z.object({
  listingExternalRef: z.string().min(1).optional(),
  rateId: z.string().min(1).optional(),
  timeslotId: z.string().min(1).optional(),
  quantity: z.number().int().min(1).max(100).optional(),
  prepaid: z.boolean().optional(),
  oversell: z.boolean().optional(),
});

channels.post('/:id/mock/book', async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const body = await c.req.json().catch(() => ({}));
  const parsed = mockBookSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const ctx = await mockCtx(c.var.operatorId, c.req.param('id'));
    const result = await mockBookNow(ctx, parsed.data);
    return c.json(result, result.ok ? 200 : 409);
  } catch (err) {
    return fail(c, err);
  }
});

const mockCancelSchema = z.object({ externalRef: z.string().min(1).optional() });

channels.post('/:id/mock/cancel', async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const body = await c.req.json().catch(() => ({}));
  const parsed = mockCancelSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const ctx = await mockCtx(c.var.operatorId, c.req.param('id'));
    const result = await mockCancelNow(ctx, parsed.data.externalRef);
    return c.json(result, result.ok ? 200 : 409);
  } catch (err) {
    return fail(c, err);
  }
});

const mockOutageSchema = z.object({
  which: z.enum(['push', 'pull']),
  message: z.string().trim().min(1).max(200).default('Partner API unavailable (503)'),
});

channels.post('/:id/mock/outage', async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const body = await c.req.json().catch(() => null);
  const parsed = mockOutageSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const ctx = await mockCtx(c.var.operatorId, c.req.param('id'));
    return c.json(await mockForceOutage(ctx, parsed.data.which, parsed.data.message));
  } catch (err) {
    return fail(c, err);
  }
});
