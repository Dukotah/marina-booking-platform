/**
 * Unit tests for the public-endpoint rate limiter. These exercise the middleware in
 * isolation via a throwaway Hono app — NO database or external service required, so
 * they run anywhere (unlike the DB-backed integration tests, which skip without
 * DATABASE_URL).
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { rateLimit, getClientIp } from '../src/middleware/rate-limit.js';

function makeApp(max: number, windowMs = 60_000) {
  const app = new Hono();
  const limiter = rateLimit({ max, windowMs });
  app.get('/hit', limiter, (c) => c.json({ ok: true }));
  return app;
}

/** Fire a request through the app with a fixed client IP header. */
function call(app: Hono, ip = '203.0.113.7') {
  return app.request('/hit', { headers: { 'x-forwarded-for': ip } });
}

describe('rateLimit middleware', () => {
  it('allows up to `max` requests then returns 429 with Retry-After', async () => {
    const max = 5;
    const app = makeApp(max);

    for (let i = 0; i < max; i++) {
      const res = await call(app);
      expect(res.status).toBe(200);
    }

    const blocked = await call(app);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    const body = (await blocked.json()) as { error: string; retryAfterSeconds: number };
    expect(body.error).toMatch(/too many requests/i);
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keys independently per client IP (one abuser does not block others)', async () => {
    const max = 3;
    const app = makeApp(max);

    // Exhaust the budget for IP A.
    for (let i = 0; i < max; i++) expect((await call(app, '198.51.100.1')).status).toBe(200);
    expect((await call(app, '198.51.100.1')).status).toBe(429);

    // A different IP still has its full budget.
    expect((await call(app, '198.51.100.2')).status).toBe(200);
  });

  it('resets the window after it expires', async () => {
    const max = 2;
    const app = makeApp(max, 20); // tiny 20ms window

    for (let i = 0; i < max; i++) expect((await call(app)).status).toBe(200);
    expect((await call(app)).status).toBe(429);

    await new Promise((r) => setTimeout(r, 30));
    expect((await call(app)).status).toBe(200);
  });

  it('getClientIp prefers x-forwarded-for, then x-real-ip, then "unknown"', () => {
    expect(getClientIp((n) => (n === 'x-forwarded-for' ? '9.9.9.9, 1.1.1.1' : undefined))).toBe(
      '9.9.9.9',
    );
    expect(getClientIp((n) => (n === 'x-real-ip' ? '8.8.8.8' : undefined))).toBe('8.8.8.8');
    expect(getClientIp(() => undefined)).toBe('unknown');
  });
});
