/**
 * Departures API — powers the customer homepage's "Today's Departures" board.
 *
 * Public (customer-facing) read:
 *   GET /  ?date=YYYY-MM-DD  -> board rows for that day (defaults to today in
 *                               the operator timezone) + the 7-day rail summary
 *
 * All heavy lifting lives in services/departures.ts, which composes the
 * existing availability + dynamic-pricing + fee math — the all-in prices it
 * returns are the same numbers checkout charges.
 *
 * Rate-limited like the other public routes, but with a read-sized budget: the
 * Next server fetches this per homepage render, so every guest arrives here
 * from ONE client IP and the default 30/min would throttle real traffic.
 */
import { Hono } from 'hono';
import type { Env } from '../context.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { AvailabilityError } from '../services/availability.js';
import { getDepartures } from '../services/departures.js';

export const departures = new Hono<Env>();

const publicRateLimit = rateLimit({ windowMs: 60_000, max: 240, bucket: 'departures' });

departures.get('/', publicRateLimit, async (c) => {
  const date = c.req.query('date');
  try {
    const result = await getDepartures(c.var.db, c.var.operatorId, { date });
    return c.json(result);
  } catch (err) {
    if (err instanceof AvailabilityError) {
      return c.json({ error: err.message }, err.status as 400 | 404);
    }
    throw err;
  }
});
