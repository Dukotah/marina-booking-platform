'use client';

import { useState, useTransition } from 'react';
import { UserPlus, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { inviteStaff, type ActionResult } from '../../app/staff/actions';
import { StaffForm, type LocationOption, type StaffFormValue } from './StaffForm';

export interface InviteStaffDialogProps {
  locations: LocationOption[];
}

const DEFAULT_VALUE: StaffFormValue = {
  role: 'STAFF',
  locationIds: [],
  extraPermissions: [],
};

/**
 * "Invite staff" action: opens a modal collecting email + name and the shared
 * role/locations/permissions form, then calls the staff:manage server action.
 * The member is created with a placeholder Clerk id and reconciled on first
 * sign-in (see actions.ts).
 */
export function InviteStaffDialog({ locations }: InviteStaffDialogProps) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [value, setValue] = useState<StaffFormValue>(DEFAULT_VALUE);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function reset() {
    setEmail('');
    setName('');
    setValue(DEFAULT_VALUE);
    setErrors({});
    setMessage(null);
  }

  function close() {
    if (isPending) return;
    setOpen(false);
    reset();
  }

  function submit() {
    if (isPending) return;
    setErrors({});
    setMessage(null);
    startTransition(async () => {
      const result: ActionResult = await inviteStaff({
        email,
        name: name.trim() || undefined,
        role: value.role,
        locationIds: value.locationIds,
        extraPermissions: value.extraPermissions,
      });
      if (result.ok) {
        setOpen(false);
        reset();
      } else {
        setErrors(result.errors ?? {});
        setMessage(result.message ?? null);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800"
      >
        <UserPlus className="h-4 w-4" aria-hidden />
        Invite staff
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Invite staff member"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="my-8 w-full max-w-lg rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="text-lg font-semibold text-slate-900">Invite staff member</h2>
              <button
                type="button"
                onClick={close}
                disabled={isPending}
                aria-label="Close"
                className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>

            <div className="max-h-[70vh] space-y-6 overflow-y-auto px-5 py-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="min-w-0">
                  <label htmlFor="invite-email" className="text-sm font-semibold text-slate-800">
                    Email
                  </label>
                  <input
                    id="invite-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={isPending}
                    autoComplete="off"
                    placeholder="name@example.com"
                    className={cn(
                      'mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200',
                      errors.email ? 'border-red-300' : 'border-slate-200 focus:border-slate-300',
                    )}
                  />
                  {errors.email ? (
                    <p className="mt-1 text-xs text-red-600">{errors.email}</p>
                  ) : null}
                </div>
                <div className="min-w-0">
                  <label htmlFor="invite-name" className="text-sm font-semibold text-slate-800">
                    Name <span className="font-normal text-slate-400">(optional)</span>
                  </label>
                  <input
                    id="invite-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={isPending}
                    autoComplete="off"
                    placeholder="Jordan Rivera"
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
                  />
                </div>
              </div>

              <StaffForm
                value={value}
                onChange={setValue}
                locations={locations}
                disabled={isPending}
                errors={errors}
              />

              {message ? <p className="text-sm text-red-600">{message}</p> : null}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button
                type="button"
                onClick={close}
                disabled={isPending}
                className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={isPending}
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isPending ? 'Sending…' : 'Send invite'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
