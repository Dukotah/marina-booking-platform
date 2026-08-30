'use client';

import { useState, useTransition } from 'react';
import { revokeHoldingAction } from './actions';

/**
 * Revoke one customer's holding, with an inline two-step confirm.
 *
 * Two steps rather than `window.confirm`: the native dialog is not stylable, reads
 * poorly on the dock tablet, and — more to the point — a confirm inside a
 * transition is easy to get wrong. The second press is a real button in the same
 * place, so keyboard focus never leaves it.
 *
 * The accessible name carries the holder's name, because a column of buttons all
 * labelled "Revoke" is unusable to anyone navigating by control.
 */
export function RevokeButton({
  membershipId,
  holdingId,
  holderName,
}: {
  membershipId: string;
  holdingId: string;
  holderName: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!confirming) {
    return (
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-600"
        >
          Revoke<span className="sr-only"> {holderName}’s membership</span>
        </button>
        {error ? (
          <span role="alert" className="text-xs text-red-700">
            {error}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        autoFocus
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await revokeHoldingAction(membershipId, holdingId);
            if (r.ok) {
              setConfirming(false);
            } else {
              setError(r.error ?? 'Could not revoke.');
              setConfirming(false);
            }
          })
        }
        className="rounded-md bg-red-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 disabled:opacity-70"
      >
        {pending ? 'Revoking…' : 'Confirm'}
        <span className="sr-only"> revoking {holderName}’s membership</span>
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => setConfirming(false)}
        className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-600"
      >
        Cancel
      </button>
    </div>
  );
}
