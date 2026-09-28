/**
 * Unit tests for the public-endpoint rate limiter. These exercise the middleware in
 * isolation via a throwaway Hono app — NO database or external service required, so
 * they run anywhere (unlike the DB-backed integration tests, which skip without
 * DATABASE_URL).
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { rateLimit, getClientIp } from '../src/middleware/rate-limit.js';

function makeApp(max: number, windowMs = 60_000, trustedProxyHops?: number) {
  const app = new Hono();
  const limiter = rateLimit({ max, windowMs, trustedProxyHops });
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

  it('keys independently per client IP behind a trusted proxy', async () => {
    const max = 3;
    // Behind one trusted proxy the proxy-appended forwarded hop IS the client.
    const app = makeApp(max, 60_000, 1);

    // Exhaust the budget for IP A.
    for (let i = 0; i < max; i++) expect((await call(app, '198.51.100.1')).status).toBe(200);
    expect((await call(app, '198.51.100.1')).status).toBe(429);

    // A different IP still has its full budget.
    expect((await call(app, '198.51.100.2')).status).toBe(200);
  });

  it('rotating x-forwarded-for does NOT mint fresh budgets when directly exposed', async () => {
    const max = 3;
    const app = makeApp(max); // trustedProxyHops = 0: forwarding headers are inert
    // Attacker rotates the header every request; all of them share one bucket.
    for (let i = 0; i < max; i++) {
      expect((await call(app, `10.0.0.${i}`)).status).toBe(200);
    }
    expect((await call(app, '10.0.0.99')).status).toBe(429);
  });

  it('resets the window after it expires', async () => {
    const max = 2;
    const app = makeApp(max, 20); // tiny 20ms window

    for (let i = 0; i < max; i++) expect((await call(app)).status).toBe(200);
    expect((await call(app)).status).toBe(429);

    await new Promise((r) => setTimeout(r, 30));
    expect((await call(app)).status).toBe(200);
  });

  it('getClientIp never trusts client-authored forwarding headers when directly exposed', () => {
    const xff = (n: string) => (n === 'x-forwarded-for' ? '9.9.9.9, 1.1.1.1' : undefined);
    // trustedHops = 0 (direct exposure): the socket address wins, forged XFF is inert.
    expect(getClientIp(xff, '203.0.113.7', 0)).toBe('203.0.113.7');
    // No socket and no trusted proxy: one shared bucket, not a budget per forged header.
    expect(getClientIp(xff, null, 0)).toBe('unknown');
    expect(getClientIp(() => undefined, null, 0)).toBe('unknown');
  });

  it('getClientIp reads the proxy-appended hop when behind trusted proxies', () => {
    // Behind ONE trusted proxy: socket = the proxy, the client is the entry the
    // proxy appended (rightmost XFF value) — never the attacker-authored leftmost.
    const forged = (n: string) =>
      n === 'x-forwarded-for' ? '6.6.6.6, 198.51.100.9' : undefined;
    expect(getClientIp(forged, '10.0.0.1', 1)).toBe('198.51.100.9');
    // Claiming more hops than exist clamps to the leftmost entry instead of crashing.
    expect(getClientIp(forged, '10.0.0.1', 9)).toBe('6.6.6.6');
  });
});
