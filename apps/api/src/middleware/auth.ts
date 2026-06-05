import { createMiddleware } from 'hono/factory';
import { verifyToken } from '@clerk/backend';
import type { Context } from 'hono';
import type { AuthContext, BuiltinRole, Permission } from '@marina/auth';
import type { Env } from '../context.js';

/**
 * Loads the staff principal and attaches an AuthContext. Must run AFTER
 * tenantMiddleware (it uses the tenant-scoped `c.var.db`).
 *
 * Auth source is gated by the same switch as the admin app (REQUIRE_CLERK_AUTH):
 *  - ENFORCED: identity comes from a verified Clerk session token in the
 *    `Authorization: Bearer <token>` header. No header shim — production-safe.
 *  - NOT enforced (default / local dev / tests): identity comes from the
 *    `x-dev-staff-id` header (a StaffMember's auth_user_id), so the app stays usable
 *    without Clerk wired up.
 *
 * Either way we resolve an auth_user_id, then load the active StaffMember for the
 * current tenant exactly the same way.
 */
const CLERK_SECRET = process.env.CLERK_SECRET_KEY;
const ENFORCE_CLERK = process.env.REQUIRE_CLERK_AUTH === 'true' && Boolean(CLERK_SECRET);

/** Resolve the caller's auth_user_id, or null if unauthenticated. */
async function resolveAuthUserId(c: Context<Env>): Promise<string | null> {
  if (ENFORCE_CLERK) {
    const authz = c.req.header('authorization');
    const token =
      authz && authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : null;
    if (!token) return null;
    try {
      const claims = await verifyToken(token, { secretKey: CLERK_SECRET! });
      return claims.sub ?? null; // Clerk user id == StaffMember.auth_user_id
    } catch {
      return null; // expired / invalid / wrong-key token
    }
  }
  // Dev shim: trust the header only when Clerk enforcement is off.
  return c.req.header('x-dev-staff-id') ?? null;
}

export const requireStaff = createMiddleware<Env>(async (c, next) => {
  const authUserId = await resolveAuthUserId(c);
  if (!authUserId) {
    return c.json({ error: 'Unauthenticated' }, 401);
  }

  const staff = await c.var.db.staffMember.findFirst({
    where: { auth_user_id: authUserId, is_active: true },
    include: { locations: { select: { location_id: true } } },
  });
  if (!staff) {
    return c.json({ error: 'Not a staff member of this operator' }, 403);
  }

  const auth: AuthContext = {
    operatorId: c.var.operatorId,
    userId: staff.auth_user_id,
    role: staff.role as BuiltinRole,
    extraPermissions: staff.extra_permissions as Permission[],
    locationIds: staff.locations.map((l) => l.location_id),
  };
  c.set('auth', auth);
  await next();
});
