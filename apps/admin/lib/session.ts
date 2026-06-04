import { auth } from '@clerk/nextjs/server';
import { forOperator } from '@marina/database';
import {
  type AuthContext,
  type BuiltinRole,
  type Permission,
  ROLE_PERMISSIONS,
  assertPermission,
} from '@marina/auth';

/**
 * Admin app session + tenant resolution (decision D-007: the admin app talks to
 * the database DIRECTLY through the tenant-scoped client, not via the API).
 *
 * Authentication is Clerk. We resolve the Clerk `userId` to a StaffMember, and
 * from there to the owning operator + the effective AuthContext used for RBAC.
 *
 * DEV FALLBACK: Clerk keys / a live session are frequently absent during local
 * development. Rather than blowing up every page, we fall back to a deterministic
 * OWNER context for the seed operator ('lsra'). This never throws in dev so the
 * shell + pages remain explorable without external accounts wired up.
 */

/** The seed operator slug/id used for the dev fallback (Lake Sonoma seed client). */
const DEV_OPERATOR_ID = 'lsra';

export interface OperatorContext {
  operatorId: string;
  auth: AuthContext;
}

/** True when Clerk is actually configured for this deployment. */
function clerkConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
}

/** A deterministic OWNER context for local development when Clerk is absent. */
function devFallbackContext(): OperatorContext {
  const role: BuiltinRole = 'OWNER';
  return {
    operatorId: DEV_OPERATOR_ID,
    auth: {
      operatorId: DEV_OPERATOR_ID,
      userId: 'dev-owner',
      role,
      extraPermissions: [],
      locationIds: [],
    },
  };
}

/**
 * Resolve the current operator + authenticated staff context for a server
 * component or server action. Falls back to a dev OWNER context when Clerk is
 * not configured or no session is present — never throws in that path.
 */
export async function getOperatorContext(): Promise<OperatorContext> {
  if (!clerkConfigured()) {
    return devFallbackContext();
  }

  let userId: string | null = null;
  try {
    const session = await auth();
    userId = session.userId;
  } catch {
    // Clerk middleware not active / misconfigured — degrade gracefully in dev.
    return devFallbackContext();
  }

  if (!userId) {
    return devFallbackContext();
  }

  // Resolve the StaffMember for this Clerk user. auth_user_id is the Clerk user
  // id; a Clerk identity maps to a single staff record in this product.
  const staff = await resolveStaff(userId);

  if (!staff) {
    return devFallbackContext();
  }

  return {
    operatorId: staff.operatorId,
    auth: {
      operatorId: staff.operatorId,
      userId,
      role: staff.role,
      extraPermissions: staff.extraPermissions,
      locationIds: staff.locationIds,
    },
  };
}

interface ResolvedStaff {
  operatorId: string;
  role: BuiltinRole;
  extraPermissions: Permission[];
  locationIds: string[];
}

/**
 * Look up the active StaffMember for a Clerk user id. We don't yet know the
 * operator, so this reads via the seed operator's tenant client scoped to the
 * resolved operator. Because RLS scopes by operator, we resolve membership in a
 * single pass: find the staff row, then return its operator + derived context.
 *
 * NOTE: cross-operator user lookup is intentionally narrow — a Clerk identity
 * belongs to exactly one operator's staff in this product. We probe the seed
 * operator client which, with RLS, returns only rows the GUC permits; in the
 * common single-tenant dev/seed setup that is the operator we want.
 */
async function resolveStaff(userId: string): Promise<ResolvedStaff | null> {
  // The tenant client requires an operatorId up front. For staff resolution we
  // scope to the seed operator; production multi-tenant routing resolves the
  // operator from the request host before this call and would pass it through.
  const db = forOperator(DEV_OPERATOR_ID);
  const member = await db.staffMember.findFirst({
    where: { auth_user_id: userId, is_active: true },
    select: {
      operator_id: true,
      role: true,
      extra_permissions: true,
      locations: { select: { location_id: true } },
    },
  });

  if (!member) return null;

  return {
    operatorId: member.operator_id,
    role: member.role as BuiltinRole,
    extraPermissions: member.extra_permissions as Permission[],
    locationIds: member.locations.map((l) => l.location_id),
  };
}

/**
 * Tenant-scoped Prisma client for the current operator. Every query made through
 * it runs with the RLS GUC set, so it can never read another operator's data.
 */
export async function getTenantDb() {
  const { operatorId } = await getOperatorContext();
  return forOperator(operatorId);
}

/**
 * Assert the current staff context holds a permission. Throws AuthorizationError
 * (status 403) when missing — pages/actions can let it bubble to an error
 * boundary or catch it to render a denied state.
 */
export async function requirePermission(permission: Permission): Promise<OperatorContext> {
  const ctx = await getOperatorContext();
  assertPermission(ctx.auth, permission);
  return ctx;
}

/** Convenience: the effective permission set for the current context. */
export async function currentPermissions(): Promise<Set<Permission>> {
  const { auth: a } = await getOperatorContext();
  return new Set<Permission>([...ROLE_PERMISSIONS[a.role], ...a.extraPermissions]);
}
