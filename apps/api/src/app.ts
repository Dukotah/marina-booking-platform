import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { AuthorizationError } from '@marina/auth';
import type { Env } from './context.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { activities } from './routes/activities.js';

export const app = new Hono<Env>();

app.use('*', logger());
app.use('*', cors());

// Liveness — no tenant required.
app.get('/health', (c) => c.json({ ok: true, service: 'marina-api' }));

// Everything under /api is tenant-scoped.
const api = new Hono<Env>();
api.use('*', tenantMiddleware);
api.route('/activities', activities);

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
