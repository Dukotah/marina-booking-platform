'use client';

import { useState, useTransition } from 'react';
import { Button } from '../ui';
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
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          Revoke<span className="sr-only"> {holderName}’s membership</span>
        </Button>
        {error ? (
          <span role="alert" className="text-xs text-rose-700">
            {error}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        variant="danger"
        size="sm"
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
      >
        {pending ? 'Revoking…' : 'Confirm'}
        <span className="sr-only"> revoking {holderName}’s membership</span>
      </Button>
      <Button variant="secondary" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </div>
  );
}
