import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { AuthorizationError } from '@marina/auth';
import type { Env } from './context.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { activities } from './routes/activities.js';
import { availability } from './routes/availability.js';
import { orders } from './routes/orders.js';
import { payments } from './routes/payments.js';
import { customers } from './routes/customers.js';
import { waivers } from './routes/waivers.js';
import { promos } from './routes/promos.js';
import { merchandise } from './routes/merchandise.js';
import { pos } from './routes/pos.js';
import { operator } from './routes/operator.js';
import { webhooks } from './routes/webhooks.js';
import { internal } from './routes/internal.js';

export const app = new Hono<Env>();

/**
 * Allowed browser origins for CORS.
 *
 * Source of truth is the `ALLOWED_ORIGINS` env var (comma-separated). If unset we
 * fall back to the known web (3000) + admin (3002) origins derived from
 * `APP_BASE_DOMAIN`. In non-production we always additionally allow any
 * localhost / 127.0.0.1 origin so local dev keeps working across ports.
 */
const isProd = process.env.NODE_ENV === 'production';

function fallbackOrigins(): string[] {
  const base = (process.env.APP_BASE_DOMAIN ?? 'localhost:3000').trim();
  const scheme = isProd ? 'https' : 'http';
  // Derive web + admin. In dev the base host is localhost:3000; admin runs on :3002.
  if (base.startsWith('localhost') || base.startsWith('127.0.0.1')) {
    return ['http://localhost:3000', 'http://localhost:3002'];
  }
  return [`${scheme}://${base}`, `${scheme}://admin.${base}`];
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const originAllowList = new Set(
  (allowedOrigins.length ? allowedOrigins : fallbackOrigins()).map((o) =>
    o.replace(/\/+$/, ''),
  ),
);

function isLocalhostOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

app.use('*', logger());
app.use(
  '*',
  cors({
    // Reflect the request origin only if it's allow-listed (or any localhost in dev).
    origin: (origin) => {
      if (!origin) return undefined; // non-browser / same-origin requests
      const normalized = origin.replace(/\/+$/, '');
      if (originAllowList.has(normalized)) return origin;
      if (!isProd && isLocalhostOrigin(normalized)) return origin;
      return null; // not allowed — omit the header, browser blocks it
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-operator-slug', 'x-dev-staff-id'],
    exposeHeaders: ['Retry-After'],
  }),
);

// Liveness — no tenant required.
app.get('/health', (c) => c.json({ ok: true, service: 'marina-api' }));

// Webhooks resolve their own tenant from the event payload — they receive no
// x-operator-slug header, so they live OUTSIDE the tenant middleware.
app.route('/webhooks', webhooks);

// Scheduled-job endpoints (reminder sweep) — no tenant context; secret-gated.
app.route('/internal', internal);

// Everything under /api is tenant-scoped.
const api = new Hono<Env>();
api.use('*', tenantMiddleware);
api.route('/activities', activities);
api.route('/availability', availability);
api.route('/orders', orders);
// /bookings is an alias for /orders used by the customer portal (lib/api.ts createBooking).
// POST /bookings -> POST /orders (create a booking); GET/PATCH on orders still use /orders.
api.route('/bookings', orders);
api.route('/payments', payments);
api.route('/customers', customers);
api.route('/waivers', waivers);
api.route('/promos', promos);
api.route('/merchandise', merchandise);
api.route('/pos', pos);
api.route('/operator', operator);

// Echo the resolved tenant — handy sanity check during scaffolding.
api.get('/whoami', (c) => c.json({ operatorId: c.var.operatorId }));


app.route('/api', api);

// Central error handling: turn auth errors into clean status codes.
app.onError((err, c) => {
  if (err instanceof AuthorizationError) {
    return c.json({ error: err.message, permission: err.permission }, 403);
  }
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));
