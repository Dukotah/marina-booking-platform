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
 *
 * Accessibility: each field's hint is bound with aria-describedby, the failure
 * message takes focus (it is the only feedback a lookup gives), and the pending
 * state is announced rather than only shown on the button.
 */

import { useEffect, useId, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useFormState, useFormStatus } from 'react-dom';
import { lookupBooking, type LookupResult } from './actions';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <>
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending || undefined}
        // The global :focus-visible outline is the brand color, which vanishes
        // against this brand-filled button; ring in slate-900 instead.
        className="w-full rounded-lg bg-brand px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? 'Looking up…' : 'Find my booking'}
      </button>
      <p role="status" className="sr-only">
        {pending ? 'Looking up your booking. Please wait.' : ''}
      </p>
    </>
  );
}

// The previous focus ring was `ring-brand/30` — a 30%-opacity tint of a colour
// the operator chooses, which cannot be relied on to reach 3:1 against white
// (WCAG 1.4.11). The brand border stays; the ring that does the work is solid.
const FIELD_CLASS =
  'w-full rounded-lg border border-slate-300 px-3 py-3 text-base focus:border-brand focus:outline-none focus:ring-2 focus:ring-slate-900 aria-[invalid=true]:border-red-500';

export function LookupForm() {
  const router = useRouter();
  const [state, formAction] = useFormState<LookupResult | null, FormData>(
    lookupBooking,
    null,
  );

  const errorRef = useRef<HTMLDivElement>(null);
  const orderHintId = useId();
  const emailHintId = useId();
  const errorId = useId();

  const failed = Boolean(state && !state.ok);
  // A no-match answers for the pair, not one field, so both carry the message.
  const describe = (hintId: string) => (failed ? `${errorId} ${hintId}` : hintId);

  useEffect(() => {
    if (state?.ok) {
      const qs = new URLSearchParams({
        order: state.orderNumber,
        email: state.email,
      });
      router.push(`/account/bookings?${qs.toString()}`);
    }
  }, [state, router]);

  // A failed lookup returns the same two fields with a message above them. Focus
  // has to move, or a keyboard/screen-reader user is left on the submit button
  // with no indication anything happened.
  useEffect(() => {
    if (failed) errorRef.current?.focus();
  }, [failed, state]);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {failed && state && !state.ok && (
        <div
          ref={errorRef}
          id={errorId}
          tabIndex={-1}
          // Focused rather than role="alert": moving focus here announces it
          // once, where an alert plus a focus move announces it twice.
          className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2"
        >
          {state.error}
        </div>
      )}

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
          aria-describedby={describe(orderHintId)}
          aria-invalid={failed || undefined}
          placeholder="e.g. ABCD260604001"
          className={`${FIELD_CLASS} uppercase tracking-wide placeholder:normal-case placeholder:tracking-normal`}
        />
        <p id={orderHintId} className="mt-1 text-xs text-slate-500">
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
          aria-describedby={describe(emailHintId)}
          aria-invalid={failed || undefined}
          placeholder="you@example.com"
          className={FIELD_CLASS}
        />
        <p id={emailHintId} className="mt-1 text-xs text-slate-500">
          The email you used when booking.
        </p>
      </div>

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
