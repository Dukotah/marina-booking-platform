/**
 * @marina/types — shared, framework-agnostic domain types and constants.
 *
 * Prisma generates the canonical DB row types in @marina/database. This package
 * holds cross-cutting types/constants that the apps and API share but that aren't
 * tied to a DB row (permissions, money helpers, well-known keys).
 */

// --- RBAC -----------------------------------------------------------------

/** Built-in roles. Custom roles may also be created per operator. */
export const BUILTIN_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'STAFF', 'GUIDE'] as const;
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];

/**
 * Granular permissions. Roles map to a set of these. Keep these stable — they are
 * referenced by stored role records.
 */
export const PERMISSIONS = [
  'operator:manage', // billing, branding, integrations, danger zone
  'location:manage',
  'activity:read',
  'activity:write',
  'order:read',
  'order:write',
  'order:refund',
  'customer:read',
  'customer:write',
  'pos:operate',
  'report:read',
  'staff:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<BuiltinRole, readonly Permission[]> = {
  OWNER: [...PERMISSIONS],
  ADMIN: PERMISSIONS.filter((p) => p !== 'operator:manage'),
  MANAGER: [
    'activity:read',
    'activity:write',
    'order:read',
    'order:write',
    'order:refund',
    'customer:read',
    'customer:write',
    'pos:operate',
    'report:read',
  ],
  STAFF: ['activity:read', 'order:read', 'order:write', 'customer:read', 'pos:operate'],
  GUIDE: ['activity:read', 'order:read'],
};

// --- Money ----------------------------------------------------------------

/** All money in the system is integer cents. These helpers keep that honest. */
export const toCents = (dollars: number): number => Math.round(dollars * 100);
export const fromCents = (cents: number): number => cents / 100;
export const formatUSD = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// --- Multi-tenancy --------------------------------------------------------

/** Postgres session GUC that RLS policies read to scope the current tenant. */
export const TENANT_GUC = 'app.current_operator_id';
