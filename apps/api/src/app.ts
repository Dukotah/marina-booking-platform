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
import { giftcards } from './routes/giftcards.js';
import { merchandise } from './routes/merchandise.js';
import { pos } from './routes/pos.js';
import { operator } from './routes/operator.js';
import { webhooks } from './routes/webhooks.js';

export const app = new Hono<Env>();

app.use('*', logger());
app.use('*', cors());

// Liveness — no tenant required.
app.get('/health', (c) => c.json({ ok: true, service: 'marina-api' }));

// Webhooks resolve their own tenant from the event payload — they receive no
// x-operator-slug header, so they live OUTSIDE the tenant middleware.
app.route('/webhooks', webhooks);

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
api.route('/giftcards', giftcards);
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
