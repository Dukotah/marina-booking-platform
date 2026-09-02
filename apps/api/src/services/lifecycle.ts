/**
 * Graceful shutdown for the HTTP server.
 *
 * Why this exists: in dev the API runs under `tsx watch`, which sends SIGTERM
 * and restarts the process on any file-system event — including files written
 * BY a request (image uploads land under `.sandbox/uploads`) and files touched
 * by neighbouring dev processes. Without a drain step, a restart that lands in
 * the middle of an order's Prisma transaction kills the process AFTER the 201
 * response body was flushed but BEFORE the write committed. The client then
 * holds an order number that never persisted — a "ghost order" that 404s at
 * /confirmation, and which the idempotency key cannot recover because there is
 * no row to return.
 *
 * The fix is to never terminate mid-request. On a shutdown signal we:
 *   1. stop accepting new connections (`server.close`),
 *   2. wait for in-flight requests to finish (the counter below hits zero),
 *   3. only then exit — so the transaction always reaches commit first.
 *
 * A hard cap (`DRAIN_TIMEOUT_MS`) guards against a wedged request holding the
 * process open forever; on timeout we exit anyway, matching the old behaviour
 * only for the pathological case. In production (real process manager, no
 * watcher) the same handlers give a clean rolling-restart drain for free.
 */
import type { ServerType } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';

/** Read at call time so a wedged request cannot hold exit open forever. */
function drainTimeoutMs(): number {
  return Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS ?? 10_000);
}

let inFlight = 0;
let draining = false;
const idleWaiters: Array<() => void> = [];

function releaseIfIdle(): void {
  if (inFlight === 0) {
    while (idleWaiters.length) idleWaiters.shift()!();
  }
}

/**
 * Counts in-flight requests. Registered as the OUTERMOST middleware so its
 * `finally` runs after every handler and inner middleware has fully settled —
 * i.e. after the response (and any transaction inside it) is done.
 */
export const trackInFlight: MiddlewareHandler = async (_c, next) => {
  inFlight += 1;
  try {
    await next();
  } finally {
    inFlight -= 1;
    if (draining) releaseIfIdle();
  }
};

/**
 * Flip into draining mode without installing signal handlers or exiting.
 * Exported for tests; the signal path sets `draining` itself.
 */
export function beginDrain(): void {
  draining = true;
}

/** Reset module state between tests. Not used by production code. */
export function __resetForTests(): void {
  inFlight = 0;
  draining = false;
  idleWaiters.length = 0;
}

/** Resolves once no request is in flight, or after the drain timeout. */
export function waitForDrain(): Promise<void> {
  if (inFlight === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Detach so a late-finishing request cannot resolve a settled promise.
      const i = idleWaiters.indexOf(onIdle);
      if (i !== -1) idleWaiters.splice(i, 1);
      resolve();
    }, drainTimeoutMs());
    // Do not let the drain timer itself keep the event loop alive.
    if (typeof timer.unref === 'function') timer.unref();
    const onIdle = () => {
      clearTimeout(timer);
      resolve();
    };
    idleWaiters.push(onIdle);
  });
}

/**
 * Install SIGTERM/SIGINT handlers that drain in-flight requests before exit.
 * Idempotent per signal; a second signal during draining forces an immediate
 * exit (operator asked twice — respect it).
 */
export function installGracefulShutdown(server: ServerType): void {
  const shutdown = (signal: NodeJS.Signals) => {
    if (draining) {
      // Second signal: stop waiting and go now.
      process.exit(0);
      return;
    }
    draining = true;

    // Stop accepting new connections; in-flight ones are allowed to finish.
    server.close();
    // Free idle keep-alive sockets so `close` is not held open by them. Only the
    // HTTP/1 server exposes this; the http2 member of ServerType does not.
    const closeIdle = (server as { closeIdleConnections?: () => void })
      .closeIdleConnections;
    if (typeof closeIdle === 'function') closeIdle.call(server);

    void waitForDrain().then(() => {
      process.exit(0);
    });

    // Re-check immediately in case nothing was in flight when the signal landed.
    releaseIfIdle();

    // Log last so the exit path above is armed even if logging throws.
    console.log(`\n${signal} received — draining in-flight requests before exit.`);
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
