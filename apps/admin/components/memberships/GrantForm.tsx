'use client';

import { useId, useRef, useState, useTransition } from 'react';
import { Button, Input, FieldLabel } from '../ui';
import { grantMembershipAction, type ActionResult } from './actions';

/**
 * Hand a membership to an existing customer, by email.
 *
 * This is the comp path — the pass someone paid for at the dock, the season pass
 * thrown in with a slip rental, the replacement for a card that went in the lake.
 * No money moves; a paid purchase goes through the customer site, which charges and
 * issues in one transaction.
 *
 * Email rather than a picker: an operator with a few thousand customers cannot use
 * a <select>, and the address is what is in front of them. The action resolves it
 * inside the tenant's own RLS scope and says plainly when there is no such customer.
 */
export function GrantForm({ membershipId }: { membershipId: string }) {
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      ref={formRef}
      className="rounded-lg border border-line bg-surface p-5 shadow-sm"
      action={(formData) =>
        startTransition(async () => {
          const r = await grantMembershipAction(membershipId, formData);
          setResult(r);
          if (r.ok) formRef.current?.reset();
        })
      }
    >
      <h2 className="text-base font-semibold text-ink">Grant this membership</h2>
      <p className="mt-1 text-sm text-ink-body">
        Issues it immediately, with the same uses and expiry a purchase would give.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <FieldLabel htmlFor={`${uid}-email`}>Customer email</FieldLabel>
          <Input
            id={`${uid}-email`}
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder="guest@example.com"
            aria-describedby={`${uid}-hint`}
          />
          <p id={`${uid}-hint`} className="mt-1 text-xs text-ink-muted">
            They must already be a customer. Book them once first if they are not.
          </p>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Granting…' : 'Grant membership'}
        </Button>
      </div>

      <div aria-live="polite" className="mt-3 min-h-[1.25rem]">
        {result?.ok ? <p className="text-sm text-emerald-700">{result.message}</p> : null}
        {result && !result.ok ? (
          <p role="alert" className="text-sm text-rose-700">
            {result.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
