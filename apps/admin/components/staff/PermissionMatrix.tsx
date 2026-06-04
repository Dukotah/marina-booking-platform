import { Check, Minus } from 'lucide-react';
import { cn } from '../../lib/cn';
import {
  PERMISSION_GROUPS,
  PERMISSION_META,
  ROLE_PERMISSIONS,
  permissionsForGroup,
  type BuiltinRole,
  type Permission,
} from './labels';

export interface PermissionMatrixProps {
  /** The member's role (determines the baseline grants). */
  role: BuiltinRole;
  /** Per-member permissions granted on top of the role baseline. */
  extraPermissions: Permission[];
  className?: string;
}

type Source = 'role' | 'extra' | 'none';

function sourceFor(role: BuiltinRole, extras: Set<Permission>, permission: Permission): Source {
  if (new Set<Permission>(ROLE_PERMISSIONS[role]).has(permission)) return 'role';
  if (extras.has(permission)) return 'extra';
  return 'none';
}

/**
 * The effective permission matrix for a single staff member: every granular
 * permission grouped by area, marked as granted by the role (filled check),
 * granted as a per-member extra (highlighted check), or not granted (dash).
 *
 * This is the "show the effective permission matrix" surface for the slice — a
 * read-only, at-a-glance view of exactly what a member can do.
 */
export function PermissionMatrix({ role, extraPermissions, className }: PermissionMatrixProps) {
  const extras = new Set<Permission>(extraPermissions);

  return (
    <div className={cn('space-y-5', className)}>
      {PERMISSION_GROUPS.map((group) => {
        const perms = permissionsForGroup(group);
        if (perms.length === 0) return null;
        return (
          <div key={group}>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {group}
            </h4>
            <ul className="space-y-1.5">
              {perms.map((permission) => {
                const meta = PERMISSION_META[permission];
                const source = sourceFor(role, extras, permission);
                return (
                  <li
                    key={permission}
                    className="flex items-start justify-between gap-3 rounded-lg px-2 py-1.5"
                  >
                    <div className="min-w-0">
                      <p
                        className={cn(
                          'text-sm font-medium',
                          source === 'none' ? 'text-slate-400' : 'text-slate-800',
                        )}
                      >
                        {meta.label}
                      </p>
                      <p className="truncate text-xs text-slate-400">{meta.description}</p>
                    </div>
                    <PermissionMark source={source} />
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function PermissionMark({ source }: { source: Source }) {
  if (source === 'none') {
    return (
      <span className="inline-flex shrink-0 items-center text-slate-300" aria-label="Not granted">
        <Minus className="h-4 w-4" aria-hidden />
      </span>
    );
  }
  const isExtra = source === 'extra';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        isExtra ? 'bg-sky-100 text-sky-700' : 'bg-emerald-100 text-emerald-700',
      )}
      aria-label={isExtra ? 'Granted as extra permission' : 'Granted by role'}
    >
      <Check className="h-3 w-3" aria-hidden />
      {isExtra ? 'Extra' : 'Role'}
    </span>
  );
}
