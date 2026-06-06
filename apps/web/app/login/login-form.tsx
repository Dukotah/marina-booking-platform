'use client';

/**
 * Two-step passwordless login (client).
 *
 *   Step 1 — enter email → `requestCode` server action emails a 6-digit code.
 *   Step 2 — enter the code → `verifyCode` sets the session cookie and redirects.
 *
 * Mobile-first, large tap targets, white-label (brand token only). The email is
 * carried from step 1 into step 2 in component state; the verify form re-submits
 * it as a hidden field so the server action is self-contained.
 */

import { useEffect, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import {
  requestCode,
  verifyCode,
  type RequestCodeState,
  type VerifyCodeState,
} from './actions';

function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-brand px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? busy : idle}
    </button>
  );
}

export function LoginForm({ next }: { next: string }) {
  const [requestState, requestAction] = useFormState<RequestCodeState | null, FormData>(
    requestCode,
    null,
  );
  const [verifyState, verifyAction] = useFormState<VerifyCodeState | null, FormData>(
    verifyCode,
    null,
  );
  const [step, setStep] = useState<'request' | 'verify'>('request');

  // Advance to the code step once a code has been requested successfully.
  useEffect(() => {
    if (requestState?.ok) setStep('verify');
  }, [requestState]);

  const email = requestState?.email ?? '';

  if (step === 'verify') {
    return (
      <form action={verifyAction} className="space-y-4" noValidate>
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="next" value={next} />

        <p className="text-sm text-slate-600">
          {requestState?.message ?? 'Enter the 6-digit code we sent you.'}
          <br />
          <span className="font-medium text-slate-900">{email}</span>
        </p>

        {requestState?.devCode && (
          <div
            role="status"
            className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          >
            Dev mode (email not configured): your code is{' '}
            <span className="font-mono font-bold tracking-widest">{requestState.devCode}</span>
          </div>
        )}

        <div>
          <label htmlFor="code" className="mb-1 block text-sm font-medium text-slate-700">
            Login code
          </label>
          <input
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={8}
            required
            autoFocus
            placeholder="123456"
            className="w-full rounded-lg border border-slate-300 px-3 py-3 text-center text-2xl font-semibold tracking-[0.4em] focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </div>

        {verifyState && !verifyState.ok && verifyState.error && (
          <div
            role="alert"
            className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          >
            {verifyState.error}
          </div>
        )}

        <Submit idle="Sign in" busy="Verifying…" />

        <button
          type="button"
          onClick={() => setStep('request')}
          className="w-full text-center text-sm font-medium text-slate-500 hover:text-slate-700"
        >
          Use a different email
        </button>
      </form>
    );
  }

  return (
    <form action={requestAction} className="space-y-4" noValidate>
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
          autoFocus
          defaultValue={requestState?.email}
          placeholder="you@example.com"
          className="w-full rounded-lg border border-slate-300 px-3 py-3 text-base focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
        <p className="mt-1 text-xs text-slate-500">
          We&apos;ll email you a one-time code — no password needed.
        </p>
      </div>

      {requestState && !requestState.ok && requestState.error && (
        <div
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {requestState.error}
        </div>
      )}

      <Submit idle="Email me a code" busy="Sending…" />
    </form>
  );
}
