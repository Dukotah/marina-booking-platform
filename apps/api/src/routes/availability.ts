/**
 * Availability + timeslots API for the resolved tenant.
 *
 * Public (customer-facing) reads:
 *   GET /            ?activityId=&date=YYYY-MM-DD   -> timeslots for that day
 *   GET /range       ?activityId=&from=&to=         -> per-day green/yellow/red summary
 *
 * Staff-only write:
 *   POST /generate   (requireStaff + activity:write)-> create slots over a date range
 *
 * All data access goes through the RLS-scoped client (c.var.db); the staff write also
 * passes c.var.operatorId so the required operator_id column is set explicitly.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import {
  AvailabilityError,
  generateTimeslotsForRange,
  getDayAvailability,
  getRangeAvailability,
} from '../services/availability.js';

export const availability = new Hono<Env>();

const ISO_DATE = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');

const dayQuerySchema = z.object({
  activityId: z.string().trim().min(1, 'activityId is required'),
  date: ISO_DATE,
});

const rangeQuerySchema = z.object({
  activityId: z.string().trim().min(1, 'activityId is required'),
  from: ISO_DATE,
  to: ISO_DATE,
});

const generateBodySchema = z
  .object({
    activityId: z.string().trim().min(1, 'activityId is required'),
    from: ISO_DATE,
    to: ISO_DATE,
    openHour: z.number().int().min(0).max(23),
    closeHour: z.number().int().min(1).max(24),
    intervalMinutes: z.number().int().positive().max(24 * 60),
    capacityTotal: z.number().int().positive(),
    /** Skip days that already have slots (idempotent re-runs). Defaults to true. */
    skipExistingDays: z.boolean().default(true),
    isOvernight: z.boolean().default(false),
  })
  .refine((v) => v.closeHour > v.openHour, {
    message: 'closeHour must be greater than openHour',
    path: ['closeHour'],
  });

/** Map service-level validation/not-found errors to clean HTTP responses. */
function handleError(c: Context<Env>, err: unknown) {
  if (err instanceof AvailabilityError) {
    return c.json({ error: err.message }, err.status as 400 | 404);
  }
  throw err; // let the central onError handler deal with anything unexpected
}

/**
 * GET / — available timeslots for one activity on one calendar day (the activity's
 * location/operator timezone). Public; RLS scopes to the resolved tenant.
 */
availability.get('/', async (c) => {
  const parsed = dayQuerySchema.safeParse({
    activityId: c.req.query('activityId'),
    date: c.req.query('date'),
  });
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await getDayAvailability(c.var.db, parsed.data);
    return c.json(result);
  } catch (err) {
    return handleError(c, err);
  }
});

/**
 * GET /range — per-day availability summary across [from, to] (both inclusive) for
 * calendar/month views. Each day carries a green/yellow/red signal. Public.
 */
availability.get('/range', async (c) => {
  const parsed = rangeQuerySchema.safeParse({
    activityId: c.req.query('activityId'),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await getRangeAvailability(c.var.db, parsed.data);
    return c.json(result);
  } catch (err) {
    return handleError(c, err);
  }
});

/**
 * POST /generate — staff endpoint that creates timeslots for an activity across a date
 * range using the operator's hours. Requires activity:write. Idempotent by default.
 */
availability.post('/generate', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:write');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = generateBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await generateTimeslotsForRange(c.var.db, {
      operatorId: c.var.operatorId,
      ...parsed.data,
    });
    return c.json(result, 201);
  } catch (err) {
    return handleError(c, err);
  }
});
