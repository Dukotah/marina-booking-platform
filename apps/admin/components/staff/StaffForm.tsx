'use client';

import { useMemo, useState } from 'react';
import { Check, MapPin } from 'lucide-react';
import { cn } from '../../lib/cn';
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
} from './labels';

/** A location option the member can be scoped to. */
export interface LocationOption {
  id: string;
  name: string;
}

/** The editable staff fields shared by the invite and edit forms. */
export interface StaffFormValue {
  role: BuiltinRole;
  locationIds: string[];
  extraPermissions: Permission[];
}

export interface StaffFormProps {
  value: StaffFormValue;
  onChange: (next: StaffFormValue) => void;
  locations: LocationOption[];
  disabled?: boolean;
  /** Field-path -> message map from a failed server action. */
  errors?: Record<string, string>;
}

/**
 * Shared role/locations/permissions editor used by both the invite dialog and the
 * inline staff editor. Renders:
 *  - a role picker (with descriptions),
 *  - per-location scoping (empty = all locations),
 *  - the role's baseline permissions (read-only) + grantable extras, and
 *  - a live effective-permission summary so the operator sees the result.
 */
export function StaffForm({ value, onChange, locations, disabled, errors }: StaffFormProps) {
  const { role, locationIds, extraPermissions } = value;

  const base = useMemo(() => new Set<Permission>(ROLE_PERMISSIONS[role]), [role]);
  const extras = useMemo(() => new Set<Permission>(extraPermissions), [extraPermissions]);

  function setRole(nextRole: BuiltinRole) {
    // Drop any extras the new role now grants by default.
    const nextBase = new Set<Permission>(ROLE_PERMISSIONS[nextRole]);
    const keptExtras = extraPermissions.filter((p) => !nextBase.has(p));
    onChange({ role: nextRole, locationIds, extraPermissions: keptExtras });
  }

  function toggleLocation(id: string) {
    const next = locationIds.includes(id)
      ? locationIds.filter((l) => l !== id)
      : [...locationIds, id];
    onChange({ role, locationIds: next, extraPermissions });
  }

  function toggleExtra(permission: Permission) {
    if (base.has(permission)) return; // role already grants it; not an extra
    const next = extras.has(permission)
      ? extraPermissions.filter((p) => p !== permission)
      : [...extraPermissions, permission];
    onChange({ role, locationIds, extraPermissions: next });
  }

  return (
    <div className="space-y-6">
      {/* Role */}
      <fieldset disabled={disabled} className="min-w-0">
        <legend className="text-sm font-semibold text-slate-800">Role</legend>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          Roles set a baseline of permissions. Grant extras below for fine-tuning.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {BUILTIN_ROLES.map((r) => {
            const selected = r === role;
            return (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                aria-pressed={selected}
                className={cn(
                  'rounded-lg border px-3 py-2 text-left transition-colors',
                  selected
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white hover:border-slate-300',
                  disabled && 'cursor-not-allowed opacity-60',
                )}
              >
                <span className="block text-sm font-semibold">{ROLE_LABELS[r]}</span>
                <span
                  className={cn(
                    'mt-0.5 block text-xs',
                    selected ? 'text-slate-300' : 'text-slate-500',
                  )}
                >
                  {ROLE_DESCRIPTIONS[r]}
                </span>
              </button>
            );
          })}
        </div>
        {errors?.role ? <p className="mt-1.5 text-xs text-red-600">{errors.role}</p> : null}
      </fieldset>

      {/* Location scoping */}
      <fieldset disabled={disabled} className="min-w-0">
        <legend className="text-sm font-semibold text-slate-800">Location access</legend>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          {locationIds.length === 0
            ? 'No locations selected — this member can access all locations.'
            : `Scoped to ${locationIds.length} of ${locations.length} location${locations.length === 1 ? '' : 's'}.`}
        </p>
        {locations.length === 0 ? (
          <p className="text-sm text-slate-400">No locations yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {locations.map((loc) => {
              const on = locationIds.includes(loc.id);
              return (
                <button
                  key={loc.id}
                  type="button"
                  onClick={() => toggleLocation(loc.id)}
                  aria-pressed={on}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors',
                    on
                      ? 'border-sky-600 bg-sky-50 text-sky-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
                    disabled && 'cursor-not-allowed opacity-60',
                  )}
                >
                  {on ? (
                    <Check className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <MapPin className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {loc.name}
                </button>
              );
            })}
          </div>
        )}
        {errors?.locationIds ? (
          <p className="mt-1.5 text-xs text-red-600">{errors.locationIds}</p>
        ) : null}
      </fieldset>

      {/* Permissions */}
      <fieldset disabled={disabled} className="min-w-0">
        <legend className="text-sm font-semibold text-slate-800">Permissions</legend>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          Permissions from the role are locked on. Toggle any extras to grant beyond
          the role.
        </p>
        <div className="space-y-4">
          {PERMISSION_GROUPS.map((group) => {
            const perms = permissionsForGroup(group);
            if (perms.length === 0) return null;
            return (
              <div key={group}>
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {group}
                </h4>
                <div className="space-y-1">
                  {perms.map((permission) => {
                    const fromRole = base.has(permission);
                    const checked = fromRole || extras.has(permission);
                    const meta = PERMISSION_META[permission];
                    return (
                      <label
                        key={permission}
                        className={cn(
                          'flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-slate-50',
                          fromRole && 'cursor-default',
                          disabled && 'cursor-not-allowed',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={fromRole || disabled}
                          onChange={() => toggleExtra(permission)}
                          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 disabled:opacity-60"
                        />
                        <span className="min-w-0">
                          <span className="flex items-center gap-2 text-sm font-medium text-slate-800">
                            {meta.label}
                            {fromRole ? (
                              <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                                Role
                              </span>
                            ) : checked ? (
                              <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700">
                                Extra
                              </span>
                            ) : null}
                          </span>
                          <span className="block text-xs text-slate-400">{meta.description}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
