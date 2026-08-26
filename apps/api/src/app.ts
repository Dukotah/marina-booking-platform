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
import { giftCards } from './routes/gift-cards.js';
import { giftCertificates } from './routes/gift-certificates.js';
import { packages } from './routes/packages.js';
import { merchandise } from './routes/merchandise.js';
import { pos } from './routes/pos.js';
import { guides } from './routes/guides.js';
import { operator } from './routes/operator.js';
import { settings } from './routes/settings.js';
import { webhooks } from './routes/webhooks.js';
import { internal } from './routes/internal.js';
import { health } from './routes/health.js';
import { uploads } from './routes/uploads.js';
import { accounting } from './routes/accounting.js';
import { channels } from './routes/channels.js';
import { customerAuth } from './routes/customer-auth.js';

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

// Liveness, readiness and build info — no tenant required. /health/ready actually
// round-trips the database, so it is a real readiness probe, not a static 200.
app.route('/health', health);

// Webhooks resolve their own tenant from the event payload — they receive no
// x-operator-slug header, so they live OUTSIDE the tenant middleware.
app.route('/webhooks', webhooks);

// Scheduled-job endpoints (reminder sweep) — no tenant context; secret-gated.
app.route('/internal', internal);

// Uploaded images. Mounted OUTSIDE the tenant middleware deliberately: serving a
// file is public (an <img> tag carries no tenant header), while the router applies
// tenantMiddleware + requireStaff itself on POST and DELETE.
app.route('/uploads', uploads);

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
api.route('/gift-cards', giftCards);
api.route('/gift-certificates', giftCertificates);
api.route('/packages', packages);
api.route('/merchandise', merchandise);
api.route('/pos', pos);
api.route('/guides', guides);
api.route('/operator', operator);
api.route('/settings', settings);
api.route('/accounting', accounting);
api.route('/channels', channels);
api.route('/customer-auth', customerAuth);

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
