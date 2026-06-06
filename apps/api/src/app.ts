import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './context.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { requestLogger, errorHandler, readyHandler } from './middleware/observability.js';
import {
  securityHeaders,
  signupLimiter,
  slugCheckLimiter,
  otpRequestLimiter,
  bookingLimiter,
} from './middleware/rateLimit.js';
import { activities } from './routes/activities.js';
import { availability } from './routes/availability.js';
import { orders } from './routes/orders.js';
import { payments } from './routes/payments.js';
import { customers } from './routes/customers.js';
import { waivers } from './routes/waivers.js';
import { promos } from './routes/promos.js';
import { giftcards } from './routes/giftcards.js';
import { merchandise } from './routes/merchandise.js';
import { resources } from './routes/resources.js';
import { pos } from './routes/pos.js';
import { reports } from './routes/reports.js';
import { operator } from './routes/operator.js';
import { webhooks } from './routes/webhooks.js';
import { jobs } from './routes/jobs.js';
import { auth } from './routes/auth.js';
import { signup } from './routes/signup.js';

export const app = new Hono<Env>();

app.use('*', requestLogger);
app.use('*', securityHeaders);
app.use('*', cors());

// Liveness — no tenant required.
app.get('/health', (c) => c.json({ ok: true, service: 'marina-api' }));
// Readiness — checks the DB is reachable (for load balancers / deploy health gates).
app.get('/ready', readyHandler);

// Webhooks resolve their own tenant from the event payload — they receive no
// x-operator-slug header, so they live OUTSIDE the tenant middleware.
app.route('/webhooks', webhooks);

// Scheduled-job triggers (e.g. reminder sweep) are platform-level — they iterate
// operators internally and authenticate with a shared secret, so they also live
// OUTSIDE the tenant middleware (no x-operator-slug header).
app.route('/jobs', jobs);

// Self-serve operator signup provisions a brand-new tenant, so it runs BEFORE any
// tenant exists — it lives OUTSIDE the tenant middleware (no x-operator-slug) and
// uses the platform connection internally. (Phase 2, D-032.)
app.route('/signup', signup);

// Everything under /api is tenant-scoped.
const api = new Hono<Env>();
// Rate-limit abuse-prone endpoints BEFORE the tenant lookup runs (registered first
// so they match ahead of the catch-all tenant middleware). See middleware/rateLimit.
api.use('/auth/customer/request', otpRequestLimiter);
api.use('/bookings', bookingLimiter);
api.use('*', tenantMiddleware);
api.route('/auth', auth);
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
api.route('/resources', resources);
api.route('/pos', pos);
api.route('/reports', reports);
api.route('/operator', operator);

// Echo the resolved tenant — handy sanity check during scaffolding.
api.get('/whoami', (c) => c.json({ operatorId: c.var.operatorId }));


app.route('/api', api);

// Central error handling: structured logging + safe envelopes (maps known error
// classes; never leaks stacks/messages for unknown 500s). See middleware/observability.
app.onError(errorHandler);

app.notFound((c) => c.json({ error: 'Not found' }, 404));
