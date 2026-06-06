/**
 * Self-serve operator signup — the public front door (Phase 2, D-032).
 *
 *   GET  /signup/slug-available?slug=foo  public — format + uniqueness check (+ suggestion)
 *   POST /signup                          public(dev) / Clerk-gated(prod) — provision a tenant
 *
 * Mounted OUTSIDE `tenantMiddleware` (alongside /webhooks and /jobs): provisioning
 * runs before any tenant exists, so there is no tenant to resolve. It uses the
 * platform (adminPrisma) connection inside the service.
 *
 * Auth posture (mirrors D-012/D-017): when Clerk is enforced, the OWNER identity
 * MUST come from a verified Clerk session token (the just-created user) and the
 * body `authUserId` is ignored — so a caller can't bind an operator to someone
 * else's id. In dev (Clerk off) the flow is open and a deterministic dev owner id
 * is generated. Abuse protection (rate limit / captcha) for the public prod
 * endpoint is a documented go-live follow-up.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { verifyToken } from '@clerk/backend';
import type { Env } from '../context.js';
import {
  provisionOperator,
  checkSlugAvailability,
  ProvisioningError,
} from '../services/provisioning.js';
import { signupLimiter, slugCheckLimiter } from '../middleware/rateLimit.js';

const CLERK_SECRET = process.env.CLERK_SECRET_KEY;
const ENFORCE_CLERK = process.env.REQUIRE_CLERK_AUTH === 'true' && Boolean(CLERK_SECRET);

export const signup = new Hono<Env>();

signup.get('/slug-available', slugCheckLimiter, async (c) => {
  const raw = c.req.query('slug') ?? '';
  if (!raw.trim()) return c.json({ error: 'A slug is required' }, 400);
  const result = await checkSlugAvailability(raw);
  return c.json(result);
});

const signupSchema = z.object({
  businessName: z.string().trim().min(2, 'A business name is required').max(160),
  ownerName: z.string().trim().max(160).optional().default(''),
  ownerEmail: z.string().trim().toLowerCase().email('A valid email is required'),
  slug: z.string().trim().max(40).optional(),
  // Only honored in dev (Clerk off). In prod the id comes from the verified token.
  authUserId: z.string().trim().max(200).optional(),
});

signup.post('/', signupLimiter, async (c) => {
  const parsed = signupSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }

  // Resolve the OWNER identity.
  let authUserId: string | undefined = parsed.data.authUserId;
  if (ENFORCE_CLERK) {
    const authz = c.req.header('authorization');
    const token = authz?.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : null;
    if (!token) return c.json({ error: 'Sign in to create an account', code: 'UNAUTHENTICATED' }, 401);
    try {
      const claims = await verifyToken(token, { secretKey: CLERK_SECRET! });
      authUserId = claims.sub ?? undefined; // trust ONLY the verified token in prod
    } catch {
      return c.json({ error: 'Your session is invalid — sign in again', code: 'UNAUTHENTICATED' }, 401);
    }
    if (!authUserId) return c.json({ error: 'Could not resolve your identity', code: 'UNAUTHENTICATED' }, 401);
  }

  try {
    const result = await provisionOperator({
      businessName: parsed.data.businessName,
      ownerName: parsed.data.ownerName,
      ownerEmail: parsed.data.ownerEmail,
      slug: parsed.data.slug,
      authUserId,
    });
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof ProvisioningError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});
