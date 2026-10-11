import type { Metadata } from 'next';
import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission, currentPermissions } from '../../../lib/session';
import { formatNumber } from '../../../lib/format';
import { InviteStaffDialog } from '../../../components/staff/InviteStaffDialog';
import { StaffTable, type StaffRow } from '../../../components/staff/StaffTable';
import {
  NotificationPrefs,
  type ActivityOption,
  type NotificationPrefRow,
} from '../../../components/staff/NotificationPrefs';
import { type LocationOption } from '../../../components/staff/StaffForm';
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
} from '../../../components/staff/labels';

export const metadata: Metadata = {
  title: 'Staff & Roles',
};

export const dynamic = 'force-dynamic';

/** True if a staff member is still on a placeholder Clerk id (invited, not joined). */
function isPending(authUserId: string): boolean {
  return authUserId.startsWith('invite:');
}

/**
 * Staff & roles — a Settings tab since the sidebar consolidation (2026-09; the
 * old top-level /staff redirects here). Rendered inside the settings layout, so
 * NO AdminShell wrapper here — the layout provides the chrome + SettingsNav.
 *
 * Gated on staff:manage (page access requires it). Lists every StaffMember with
 * their role + location scope, supports inviting new members and inline editing
 * of role / per-location scoping / extra permissions, and shows the role →
 * permission reference matrix.
 *
 * All reads/writes go through the tenant-scoped client (RLS), so only this
 * operator's staff and locations are ever visible.
 */
export default async function StaffPage() {
  await requirePermission('staff:manage');
  const db = await getTenantDb();
  const permissions = await currentPermissions();
  const canManage = permissions.has('staff:manage');

  const [members, locations, activities] = await Promise.all([
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
        notification_pref: {
          select: {
            email_enabled: true,
            sms_enabled: true,
            sms_phone: true,
            activity_ids: true,
          },
        },
      },
    }),
    db.location.findMany({
      where: { is_active: true },
      orderBy: [{ is_default: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true },
    }),
    db.activity.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name_internal: 'asc' },
      select: { id: true, name_internal: true, name_external: true },
    }),
  ]);

  const locationOptions: LocationOption[] = locations.map((l) => ({ id: l.id, name: l.name }));
  const activityOptions: ActivityOption[] = activities.map((a) => ({
    id: a.id,
    name: a.name_internal || a.name_external,
  }));

  // Booking-notification prefs apply to members who can manage bookings (not guides).
  const notificationRows: NotificationPrefRow[] = members
    .filter((m) => m.is_active && m.role !== 'GUIDE')
    .map((m) => ({
      staffId: m.id,
      name: m.name ?? '',
      email: m.email,
      emailEnabled: m.notification_pref ? m.notification_pref.email_enabled : true,
      smsEnabled: m.notification_pref ? m.notification_pref.sms_enabled : false,
      smsPhone: m.notification_pref?.sms_phone ?? null,
      activityIds: m.notification_pref?.activity_ids ?? [],
    }));

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
    <>
      <PageHeader
        title="Staff & Roles"
        description={description}
        actions={canManage ? <InviteStaffDialog locations={locationOptions} /> : undefined}
      />

      <StaffTable rows={rows} locations={locationOptions} canManage={canManage} />

      <section className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight text-ink">
          Booking notifications
        </h2>
        <p className="mb-4 mt-1 text-sm text-ink-muted">
          Choose who gets alerted when a new booking comes in, by email or text, and
          narrow alerts to specific activities so they are not all-or-nothing.
        </p>
        <NotificationPrefs
          rows={notificationRows}
          activities={activityOptions}
          canManage={canManage}
        />
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight text-ink">Role reference</h2>
        <p className="mb-4 mt-1 text-sm text-ink-muted">
          Default permissions granted by each built-in role. Individual members can be
          granted extra permissions on top of their role.
        </p>
        <RolePermissionMatrix />
      </section>
    </>
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
    <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-muted">
              <th
                scope="col"
                className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted"
              >
                Permission
              </th>
              {BUILTIN_ROLES.map((role) => (
                <th
                  key={role}
                  scope="col"
                  className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wide text-ink-muted"
                  title={ROLE_DESCRIPTIONS[role]}
                >
                  {ROLE_LABELS[role]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
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
      <tr className="bg-surface-muted/60">
        <td
          colSpan={BUILTIN_ROLES.length + 1}
          className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-muted"
        >
          {group}
        </td>
      </tr>
      {perms.map((permission) => {
        const meta = PERMISSION_META[permission];
        return (
          <tr key={permission}>
            <td className="px-4 py-3">
              <div className="font-medium text-ink">{meta.label}</div>
              <div className="text-xs text-ink-muted">{meta.description}</div>
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
                    className="inline-block h-2.5 w-2.5 rounded-full bg-line-strong"
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
