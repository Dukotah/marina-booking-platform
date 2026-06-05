/**
 * Customer auth API — passwordless email-OTP login (ROADMAP 0.7).
 *
 *   POST /api/auth/customer/request   public — request a login code by email
 *   POST /api/auth/customer/verify    public — exchange email + code for a token
 *
 * Tenant-scoped (under tenantMiddleware): codes + tokens are bound to the resolved
 * operator. Staff auth is separate (Clerk; see middleware/auth.ts). The returned
 * token is a stateless bearer the web app sends to customer self-service endpoints.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../context.js';
import { requestLoginCode, verifyLoginCode, CustomerAuthError } from '../services/customer-auth.js';

export const auth = new Hono<Env>();

const requestSchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required'),
});

const verifySchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  code: z.string().trim().min(4).max(8),
});

auth.post('/customer/request', async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const result = await requestLoginCode(c.var.operatorId, parsed.data.email);
    return c.json(result);
  } catch (err) {
    if (err instanceof CustomerAuthError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});

auth.post('/customer/verify', async (c) => {
  const parsed = verifySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const result = await verifyLoginCode(c.var.operatorId, parsed.data.email, parsed.data.code);
    return c.json(result);
  } catch (err) {
    if (err instanceof CustomerAuthError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});
