'use client';

import { Fragment, useState } from 'react';
import { ChevronDown, MapPin, Mail } from 'lucide-react';
import { cn } from '../../lib/cn';
import { StaffEditor } from './StaffEditor';
import { type LocationOption } from './StaffForm';
import {
  ROLE_LABELS,
  type BuiltinRole,
  type Permission,
} from './labels';

/** A staff member as projected for the list (serializable; no Date objects). */
export interface StaffRow {
  id: string;
  email: string;
  name: string | null;
  role: BuiltinRole;
  extraPermissions: Permission[];
  locationIds: string[];
  isActive: boolean;
  /** True while the member still has a placeholder Clerk id (invited, not joined). */
  pending: boolean;
}

export interface StaffTableProps {
  rows: StaffRow[];
  locations: LocationOption[];
  /** When false, the table is read-only (no staff:manage permission). */
  canManage: boolean;
}

function locationNames(ids: string[], locations: LocationOption[]): string {
  if (ids.length === 0) return 'All locations';
  const byId = new Map(locations.map((l) => [l.id, l.name]));
  return ids.map((id) => byId.get(id) ?? 'Unknown').join(', ');
}

const roleBadgeClass: Record<BuiltinRole, string> = {
  OWNER: 'bg-violet-100 text-violet-700',
  ADMIN: 'bg-indigo-100 text-indigo-700',
  MANAGER: 'bg-sky-100 text-sky-700',
  STAFF: 'bg-slate-100 text-slate-700',
  GUIDE: 'bg-emerald-100 text-emerald-700',
};

/**
 * Staff roster: one row per member showing name/email, role, location scope, and
 * status. When the operator can manage staff, each row expands inline to the full
 * editor (role, location scoping, extra permissions, effective matrix).
 */
export function StaffTable({ rows, locations, canManage }: StaffTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-12 text-center text-slate-500 shadow-sm">
        No staff members yet.
        {canManage ? ' Invite your first team member to get started.' : ''}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left">
              <th
                scope="col"
                className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Member
              </th>
              <th
                scope="col"
                className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Role
              </th>
              <th
                scope="col"
                className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Locations
              </th>
              <th
                scope="col"
                className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Status
              </th>
              {canManage ? <th scope="col" className="px-4 py-3" /> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => {
              const expanded = expandedId === row.id;
              const colSpan = canManage ? 5 : 4;
              return (
                <Fragment key={row.id}>
                  <tr
                    className={cn(
                      'transition-colors',
                      canManage && 'cursor-pointer hover:bg-slate-50',
                      expanded && 'bg-slate-50',
                    )}
                    onClick={canManage ? () => setExpandedId(expanded ? null : row.id) : undefined}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">
                        {row.name || row.email}
                      </div>
                      <div className="flex items-center gap-1 text-xs text-slate-500">
                        <Mail className="h-3 w-3" aria-hidden />
                        {row.email}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
                          roleBadgeClass[row.role],
                        )}
                      >
                        {ROLE_LABELS[row.role]}
                      </span>
                      {row.extraPermissions.length > 0 ? (
                        <span className="ml-2 text-xs text-sky-600">
                          +{row.extraPermissions.length} extra
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                        {locationNames(row.locationIds, locations)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {row.pending ? (
                        <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                          Invited
                        </span>
                      ) : row.isActive ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">
                          Inactive
                        </span>
                      )}
                    </td>
                    {canManage ? (
                      <td className="px-4 py-3 text-right">
                        <ChevronDown
                          className={cn(
                            'inline h-4 w-4 text-slate-400 transition-transform',
                            expanded && 'rotate-180',
                          )}
                          aria-hidden
                        />
                      </td>
                    ) : null}
                  </tr>
                  {canManage && expanded ? (
                    <tr className="bg-slate-50">
                      <td colSpan={colSpan} className="px-4 pb-5 pt-1">
                        <StaffEditor
                          staffId={row.id}
                          isActive={row.isActive}
                          initial={{
                            role: row.role,
                            locationIds: row.locationIds,
                            extraPermissions: row.extraPermissions,
                          }}
                          locations={locations}
                          onDone={() => setExpandedId(null)}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
