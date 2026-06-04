import { createMiddleware } from 'hono/factory';
import type { AuthContext, BuiltinRole, Permission } from '@marina/auth';
import type { Env } from '../context.js';

/**
 * Loads the staff principal and attaches an AuthContext. Must run AFTER
 * tenantMiddleware (it uses the tenant-scoped `c.var.db`).
 *
 * DEV SHIM: identity comes from the `x-dev-staff-id` header (a StaffMember's Clerk
 * user id). TODO(0.7): replace with Clerk session-token verification once keys are
 * configured — resolve the Clerk user id, then load the StaffMember exactly as below.
 */
export const requireStaff = createMiddleware<Env>(async (c, next) => {
  const authUserId = c.req.header('x-dev-staff-id'); // TODO: from verified Clerk session
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
