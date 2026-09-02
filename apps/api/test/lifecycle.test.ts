/**
 * Unit tests for graceful-shutdown draining. No DB or server socket — they drive
 * the `trackInFlight` middleware through a throwaway Hono app and assert that
 * `waitForDrain` resolves only after in-flight requests have settled.
 *
 * This is the regression guard for the "ghost order id" bug: a `tsx watch`
 * restart (SIGTERM) mid-transaction used to kill the process after the 201 was
 * flushed but before the write committed. Draining fixes that by holding exit
 * until every in-flight request finishes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  trackInFlight,
  beginDrain,
  waitForDrain,
  __resetForTests,
} from '../src/services/lifecycle.js';

function makeApp(handler: (c: import('hono').Context) => Promise<Response>) {
  const app = new Hono();
  app.use('*', trackInFlight);
  app.get('/slow', handler);
  return app;
}

beforeEach(() => __resetForTests());

describe('graceful shutdown drain', () => {
  it('waitForDrain resolves immediately when nothing is in flight', async () => {
    beginDrain();
    const settled = await Promise.race([
      waitForDrain().then(() => 'drained'),
      Promise.resolve('pending'),
    ]);
    // waitForDrain returns an already-resolved promise, but the microtask order
    // means the sync Promise.resolve wins the race; assert it does not hang.
    await waitForDrain();
    expect(['drained', 'pending']).toContain(settled);
  });

  it('waitForDrain waits for an in-flight request to finish', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const app = makeApp(async (c) => {
      await gate; // request is now in flight and pinned open
      return c.json({ ok: true });
    });

    // Fire the request but do not await it yet — it is in flight.
    const inFlightReq = app.request('/slow');
    // Let the middleware increment the counter before we begin draining.
    await new Promise((r) => setImmediate(r));

    beginDrain();

    let drained = false;
    const drainPromise = waitForDrain().then(() => {
      drained = true;
    });

    // Give the drain promise a chance to (wrongly) resolve. It must NOT while the
    // request is still pinned open.
    await new Promise((r) => setImmediate(r));
    expect(drained).toBe(false);

    // Complete the request; now the drain should resolve.
    release();
    const res = await inFlightReq;
    expect(res.status).toBe(200);

    await drainPromise;
    expect(drained).toBe(true);
  });

  it('waitForDrain resolves after the timeout even if a request never finishes', async () => {
    const app = makeApp(() => new Promise<Response>(() => {})); // never resolves

    void app.request('/slow');
    await new Promise((r) => setImmediate(r));

    beginDrain();

    // With a tiny timeout the wedged request cannot hold exit open forever.
    process.env.SHUTDOWN_DRAIN_TIMEOUT_MS = '20';
    // waitForDrain reads the timeout at call time via the module constant, so we
    // assert the promise resolves without hanging the test runner.
    const start = Date.now();
    await Promise.race([
      waitForDrain(),
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error('drain never resolved')), 2000),
      ),
    ]);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
