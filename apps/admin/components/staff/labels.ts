import {
  BUILTIN_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  type BuiltinRole,
  type Permission,
} from '@marina/auth';

/**
 * Display metadata for the staff & roles slice. Roles and permissions are stable,
 * machine-readable identifiers in @marina/auth; this file is the single place the
 * admin UI translates them into human-friendly labels and descriptions so the
 * staff list, editor, and permission matrix stay consistent.
 */

/** Human label for a role ("OWNER" -> "Owner"). */
export const ROLE_LABELS: Record<BuiltinRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  STAFF: 'Staff',
  GUIDE: 'Guide',
};

/** One-line description of what each role is for, shown in the role picker. */
export const ROLE_DESCRIPTIONS: Record<BuiltinRole, string> = {
  OWNER: 'Full access including billing, branding, integrations, and danger zone.',
  ADMIN: 'Everything an owner can do except operator-level settings and billing.',
  MANAGER: 'Runs day-to-day operations: catalog, orders, refunds, customers, POS, reports.',
  STAFF: 'Front-line staff: take and manage bookings, operate the register.',
  GUIDE: 'Read-only access to the catalog and assigned bookings.',
};

/** Human label + grouping for each granular permission, used by the matrix. */
export const PERMISSION_META: Record<Permission, { label: string; description: string; group: string }> = {
  'operator:manage': {
    label: 'Manage operator',
    description: 'Billing, branding, integrations, and danger zone.',
    group: 'Administration',
  },
  'location:manage': {
    label: 'Manage locations',
    description: 'Create and edit locations/sites.',
    group: 'Administration',
  },
  'staff:manage': {
    label: 'Manage staff',
    description: 'Invite staff, set roles, scope locations, and grant permissions.',
    group: 'Administration',
  },
  'activity:read': {
    label: 'View catalog',
    description: 'See activities, rates, and schedules.',
    group: 'Catalog',
  },
  'activity:write': {
    label: 'Edit catalog',
    description: 'Create and edit activities, rates, and schedules.',
    group: 'Catalog',
  },
  'order:read': {
    label: 'View orders',
    description: 'See bookings and the manifest.',
    group: 'Bookings',
  },
  'order:write': {
    label: 'Manage orders',
    description: 'Create, edit, check in, and cancel bookings.',
    group: 'Bookings',
  },
  'order:refund': {
    label: 'Refund orders',
    description: 'Issue full and partial refunds.',
    group: 'Bookings',
  },
  'customer:read': {
    label: 'View customers',
    description: 'See the customer CRM.',
    group: 'Customers',
  },
  'customer:write': {
    label: 'Edit customers',
    description: 'Edit customer profiles, tags, and notes.',
    group: 'Customers',
  },
  'pos:operate': {
    label: 'Operate POS',
    description: 'Use the point-of-sale register.',
    group: 'Bookings',
  },
  'report:read': {
    label: 'View reports',
    description: 'Access revenue and occupancy reporting.',
    group: 'Reports',
  },
};

/** Ordered permission groups for rendering the matrix consistently. */
export const PERMISSION_GROUPS = [
  'Administration',
  'Catalog',
  'Bookings',
  'Customers',
  'Reports',
] as const;

/** Permissions for a group, in PERMISSIONS declaration order. */
export function permissionsForGroup(group: string): Permission[] {
  return PERMISSIONS.filter((p) => PERMISSION_META[p].group === group);
}

/** The permissions a role grants by default (never editable as "extras"). */
export function basePermissions(role: BuiltinRole): Set<Permission> {
  return new Set<Permission>(ROLE_PERMISSIONS[role]);
}

export { BUILTIN_ROLES, PERMISSIONS, ROLE_PERMISSIONS };
export type { BuiltinRole, Permission };
