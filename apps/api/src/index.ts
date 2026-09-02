import { serve } from '@hono/node-server';
import { app } from './app.js';
import { installGracefulShutdown } from './services/lifecycle.js';

const port = Number(process.env.PORT ?? 3001);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`🚤 marina-api listening on http://localhost:${info.port}`);
});

// Drain in-flight requests before exiting on SIGTERM/SIGINT. Under `tsx watch`
// a restart sends SIGTERM; without this an order's Prisma transaction can be
// killed after the 201 was flushed but before it committed (ghost order id).
installGracefulShutdown(server);
