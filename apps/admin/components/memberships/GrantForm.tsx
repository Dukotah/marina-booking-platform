'use client';

import { useId, useRef, useState, useTransition } from 'react';
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
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
      action={(formData) =>
        startTransition(async () => {
          const r = await grantMembershipAction(membershipId, formData);
          setResult(r);
          if (r.ok) formRef.current?.reset();
        })
      }
    >
      <h2 className="text-base font-semibold text-slate-900">Grant this membership</h2>
      <p className="mt-1 text-sm text-slate-600">
        Issues it immediately, with the same uses and expiry a purchase would give.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <label htmlFor={`${uid}-email`} className="block text-sm font-medium text-slate-700">
            Customer email
          </label>
          <input
            id={`${uid}-email`}
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder="guest@example.com"
            aria-describedby={`${uid}-hint`}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600"
          />
          <p id={`${uid}-hint`} className="mt-1 text-xs text-slate-600">
            They must already be a customer. Book them once first if they are not.
          </p>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 disabled:opacity-70"
        >
          {pending ? 'Granting…' : 'Grant membership'}
        </button>
      </div>

      <div aria-live="polite" className="mt-3 min-h-[1.25rem]">
        {result?.ok ? <p className="text-sm text-emerald-800">{result.message}</p> : null}
        {result && !result.ok ? (
          <p role="alert" className="text-sm text-red-700">
            {result.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
