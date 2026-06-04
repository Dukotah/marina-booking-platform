import type { Metadata } from 'next';
import { AdminShell, PageHeader } from '../../components/shell';
import { getTenantDb, requirePermission, currentPermissions } from '../../lib/session';
import { formatNumber } from '../../lib/format';
import { InviteStaffDialog } from '../../components/staff/InviteStaffDialog';
import { StaffTable, type StaffRow } from '../../components/staff/StaffTable';
import { type LocationOption } from '../../components/staff/StaffForm';
import {
  BUILTIN_ROLES,
  PERMISSION_GROUPS,
  PERMISSION_META,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  permissionsForGroup,
  type BuiltinRole,
  type Permission,
} from '../../components/staff/labels';

export const metadata: Metadata = {
  title: 'Staff & Roles',
};

export const dynamic = 'force-dynamic';

/** True if a staff member is still on a placeholder Clerk id (invited, not joined). */
function isPending(authUserId: string): boolean {
  return authUserId.startsWith('invite:');
}

/**
 * Staff & roles. Gated on staff:manage (page access requires it). Lists every
 * StaffMember with their role + location scope, supports inviting new members and
 * inline editing of role / per-location scoping / extra permissions, and shows the
 * role → permission reference matrix.
 *
 * All reads/writes go through the tenant-scoped client (RLS), so only this
 * operator's staff and locations are ever visible.
 */
export default async function StaffPage() {
  await requirePermission('staff:manage');
  const db = await getTenantDb();
  const permissions = await currentPermissions();
  const canManage = permissions.has('staff:manage');

  const [members, locations] = await Promise.all([
    db.staffMember.findMany({
      orderBy: [{ is_active: 'desc' }, { role: 'asc' }, { email: 'asc' }],
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        extra_permissions: true,
        is_active: true,
        auth_user_id: true,
        locations: { select: { location_id: true } },
      },
    }),
    db.location.findMany({
      where: { is_active: true },
      orderBy: [{ is_default: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true },
    }),
  ]);

  const locationOptions: LocationOption[] = locations.map((l) => ({ id: l.id, name: l.name }));

  const rows: StaffRow[] = members.map((m) => ({
    id: m.id,
    email: m.email,
    name: m.name,
    role: m.role as BuiltinRole,
    extraPermissions: m.extra_permissions as Permission[],
    locationIds: m.locations.map((l) => l.location_id),
    isActive: m.is_active,
    pending: isPending(m.auth_user_id),
  }));

  const activeCount = rows.filter((r) => r.isActive).length;
  const description = `${formatNumber(rows.length)} ${rows.length === 1 ? 'member' : 'members'} · ${formatNumber(activeCount)} active`;

  return (
    <AdminShell>
      <PageHeader
        title="Staff & Roles"
        description={description}
        actions={canManage ? <InviteStaffDialog locations={locationOptions} /> : undefined}
      />

      <StaffTable rows={rows} locations={locationOptions} canManage={canManage} />

      <section className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Role reference</h2>
        <p className="mb-4 mt-1 text-sm text-slate-500">
          Default permissions granted by each built-in role. Individual members can be
          granted extra permissions on top of their role.
        </p>
        <RolePermissionMatrix />
      </section>
    </AdminShell>
  );
}

/**
 * Static reference grid: permissions (rows, grouped) × built-in roles (columns),
 * with a check where the role grants that permission by default.
 */
function RolePermissionMatrix() {
  const roleHasPermission = (role: BuiltinRole, permission: Permission): boolean =>
    new Set<Permission>(ROLE_PERMISSIONS[role]).has(permission);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th
                scope="col"
                className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Permission
              </th>
              {BUILTIN_ROLES.map((role) => (
                <th
                  key={role}
                  scope="col"
                  className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wide text-slate-500"
                  title={ROLE_DESCRIPTIONS[role]}
                >
                  {ROLE_LABELS[role]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {PERMISSION_GROUPS.map((group) => {
              const perms = permissionsForGroup(group);
              if (perms.length === 0) return null;
              return (
                <PermissionGroupRows
                  key={group}
                  group={group}
                  perms={perms}
                  roleHasPermission={roleHasPermission}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PermissionGroupRows({
  group,
  perms,
  roleHasPermission,
}: {
  group: string;
  perms: Permission[];
  roleHasPermission: (role: BuiltinRole, permission: Permission) => boolean;
}) {
  return (
    <>
      <tr className="bg-slate-50/60">
        <td
          colSpan={BUILTIN_ROLES.length + 1}
          className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400"
        >
          {group}
        </td>
      </tr>
      {perms.map((permission) => {
        const meta = PERMISSION_META[permission];
        return (
          <tr key={permission}>
            <td className="px-4 py-3">
              <div className="font-medium text-slate-800">{meta.label}</div>
              <div className="text-xs text-slate-400">{meta.description}</div>
            </td>
            {BUILTIN_ROLES.map((role) => (
              <td key={role} className="px-4 py-3 text-center">
                {roleHasPermission(role, permission) ? (
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500"
                    aria-label="Granted"
                  />
                ) : (
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full bg-slate-200"
                    aria-label="Not granted"
                  />
                )}
              </td>
            ))}
          </tr>
        );
      })}
    </>
  );
}
