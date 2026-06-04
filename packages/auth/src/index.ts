/**
 * @marina/auth — framework-agnostic authorization (RBAC) helpers.
 *
 * Authentication (verifying *who* a user is) is handled by Clerk at the edge of each
 * app. This package answers *what they may do* once identified, and is the single
 * source of truth for permission checks across the API and admin app.
 */
import {
  ROLE_PERMISSIONS,
  type BuiltinRole,
  type Permission,
} from '@marina/types';

export type { BuiltinRole, Permission };
export { PERMISSIONS, BUILTIN_ROLES, ROLE_PERMISSIONS } from '@marina/types';

/**
 * The authenticated principal for a request, resolved from the Clerk session +
 * the StaffMember record. Customer (magic-link) sessions use a separate, narrower
 * context and never carry staff permissions.
 */
export interface AuthContext {
  operatorId: string;
  userId: string;
  role: BuiltinRole;
  /** Per-member permissions granted on top of the role defaults. */
  extraPermissions: Permission[];
  /** Locations this staff member is scoped to; empty = all locations. */
  locationIds: string[];
}

/** The full effective permission set for a role + any per-member extras. */
export function effectivePermissions(
  role: BuiltinRole,
  extra: Permission[] = [],
): Set<Permission> {
  return new Set<Permission>([...ROLE_PERMISSIONS[role], ...extra]);
}

export function hasPermission(ctx: AuthContext, permission: Permission): boolean {
  return effectivePermissions(ctx.role, ctx.extraPermissions).has(permission);
}

/** Throws a 403-style error if the permission is missing. Use in route handlers. */
export function assertPermission(ctx: AuthContext, permission: Permission): void {
  if (!hasPermission(ctx, permission)) {
    throw new AuthorizationError(permission);
  }
}

/** True if the staff member may act on a given location. Empty scope = all. */
export function canAccessLocation(ctx: AuthContext, locationId: string): boolean {
  return ctx.locationIds.length === 0 || ctx.locationIds.includes(locationId);
}

export class AuthorizationError extends Error {
  readonly status = 403;
  readonly permission: Permission;
  constructor(permission: Permission) {
    super(`Missing required permission: ${permission}`);
    this.name = 'AuthorizationError';
    this.permission = permission;
  }
}
