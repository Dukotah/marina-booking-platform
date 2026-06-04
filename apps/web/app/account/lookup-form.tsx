'use client';

/**
 * Booking lookup form (client). Posts to the `lookupBooking` server action and,
 * on success, navigates to the bookings view with the verified order number +
 * email in the query string (the magic-link stub carries identity in the URL
 * until a real session exists — noted as a followup).
 *
 * Mobile-first: single-column, large tap targets. White-label: uses the tenant
 * brand color via the `brand` Tailwind token / `--brand-color` variable only —
 * no platform or marina-specific branding.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useFormState, useFormStatus } from 'react-dom';
import { lookupBooking, type LookupResult } from './actions';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-brand px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Looking up…' : 'Find my booking'}
    </button>
  );
}

export function LookupForm() {
  const router = useRouter();
  const [state, formAction] = useFormState<LookupResult | null, FormData>(
    lookupBooking,
    null,
  );

  useEffect(() => {
    if (state?.ok) {
      const qs = new URLSearchParams({
        order: state.orderNumber,
        email: state.email,
      });
      router.push(`/account/bookings?${qs.toString()}`);
    }
  }, [state, router]);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <div>
        <label
          htmlFor="orderNumber"
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          Confirmation number
        </label>
        <input
          id="orderNumber"
          name="orderNumber"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          required
          placeholder="e.g. ABCD260604001"
          className="w-full rounded-lg border border-slate-300 px-3 py-3 text-base uppercase tracking-wide placeholder:normal-case placeholder:tracking-normal focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
        <p className="mt-1 text-xs text-slate-500">
          On your confirmation email and receipt.
        </p>
      </div>

      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-700">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
          className="w-full rounded-lg border border-slate-300 px-3 py-3 text-base focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
        <p className="mt-1 text-xs text-slate-500">
          The email you used when booking.
        </p>
      </div>

      {state && !state.ok && (
        <div
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {state.error}
        </div>
      )}

      {state?.ok && (
        <div
          role="status"
          className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800"
        >
          Booking found — opening your reservation…
        </div>
      )}

      <SubmitButton />
    </form>
  );
}
