'use client';

import { useState, useTransition } from 'react';
import { cn } from '../../lib/cn';
import {
  toggleStaffActive,
  updateStaff,
  type ActionResult,
} from '../../app/staff/actions';
import { StaffForm, type LocationOption, type StaffFormValue } from './StaffForm';
import { PermissionMatrix } from './PermissionMatrix';
import type { BuiltinRole, Permission } from './labels';

export interface StaffEditorProps {
  staffId: string;
  isActive: boolean;
  initial: StaffFormValue;
  locations: LocationOption[];
  /** Called to collapse the editor (e.g. after a successful save). */
  onDone?: () => void;
}

/** Shallow equality for the editable staff fields, ignoring array order. */
function sameValue(a: StaffFormValue, b: StaffFormValue): boolean {
  if (a.role !== b.role) return false;
  if (!sameSet(a.locationIds, b.locationIds)) return false;
  if (!sameSet(a.extraPermissions, b.extraPermissions)) return false;
  return true;
}

function sameSet<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/**
 * Inline editor for a single staff member: edit role, location scope, and extra
 * permissions through the shared StaffForm, with a live effective-permission
 * matrix beside it. Also exposes activate/deactivate. All mutations go through
 * the staff:manage server actions.
 */
export function StaffEditor({
  staffId,
  isActive,
  initial,
  locations,
  onDone,
}: StaffEditorProps) {
  const [saved, setSaved] = useState<StaffFormValue>(initial);
  const [value, setValue] = useState<StaffFormValue>(initial);
  const [active, setActive] = useState(isActive);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saved'>('idle');
  const [isPending, startTransition] = useTransition();

  const dirty = !sameValue(value, saved);

  function save() {
    if (!dirty || isPending) return;
    setErrors({});
    setMessage(null);
    setStatus('idle');
    startTransition(async () => {
      const result: ActionResult = await updateStaff({
        staffId,
        role: value.role,
        locationIds: value.locationIds,
        extraPermissions: value.extraPermissions,
      });
      if (result.ok) {
        setSaved(value);
        setStatus('saved');
        onDone?.();
      } else {
        setErrors(result.errors ?? {});
        setMessage(result.message ?? 'Failed to save changes.');
      }
    });
  }

  function toggleActive() {
    if (isPending) return;
    setMessage(null);
    startTransition(async () => {
      const result: ActionResult = await toggleStaffActive(staffId);
      if (result.ok) {
        setActive((a) => !a);
      } else {
        setMessage(result.message ?? 'Failed to update status.');
      }
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="min-w-0">
        <StaffForm
          value={value}
          onChange={(next) => {
            setValue(next);
            if (status !== 'idle') setStatus('idle');
          }}
          locations={locations}
          disabled={isPending}
          errors={errors}
        />

        {message ? <p className="mt-4 text-sm text-red-600">{message}</p> : null}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
          <button
            type="button"
            onClick={toggleActive}
            disabled={isPending}
            className={cn(
              'rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50',
              active
                ? 'text-red-600 hover:bg-red-50'
                : 'text-emerald-700 hover:bg-emerald-50',
            )}
          >
            {active ? 'Deactivate member' : 'Reactivate member'}
          </button>

          <div className="flex items-center gap-3">
            {status === 'saved' && !dirty ? (
              <span className="text-xs text-emerald-600">Saved.</span>
            ) : null}
            {dirty ? (
              <button
                type="button"
                onClick={() => {
                  setValue(saved);
                  setErrors({});
                  setMessage(null);
                }}
                disabled={isPending}
                className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50"
              >
                Reset
              </button>
            ) : null}
            <button
              type="button"
              onClick={save}
              disabled={!dirty || isPending}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>

      <aside className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-800">Effective access</h3>
        <PermissionMatrix
          role={value.role as BuiltinRole}
          extraPermissions={value.extraPermissions as Permission[]}
        />
      </aside>
    </div>
  );
}
