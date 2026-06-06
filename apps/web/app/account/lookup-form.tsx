'use client';

/**
 * Two-step customer sign-in (email OTP). Replaces the order#+email URL stub:
 *
 *   Step 1 (identify): order number + email → `requestOtp` server action. The API
 *     never reveals whether the order exists, so we always advance to step 2.
 *   Step 2 (verify): 6-digit code → `verifyOtp` server action, which sets the
 *     httpOnly session cookie. On success we navigate to /account/bookings — identity
 *     now lives in the cookie, not the URL.
 *
 * In dev (no email provider) the API returns a `devCode`; we prefill it and show a
 * hint so the flow is testable end-to-end without Resend.
 *
 * Mobile-first, white-label (brand token only — no platform/marina branding).
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormState, useFormStatus } from 'react-dom';
import {
  requestOtp,
  verifyOtp,
  type RequestOtpResult,
  type VerifyOtpResult,
} from './actions';

function SubmitButton({ idle, busy }: { idle: string; busy: string }) {
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

function ErrorAlert({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"
    >
      {message}
    </div>
  );
}

export function LookupForm() {
  const router = useRouter();

  const [requestState, requestAction] = useFormState<RequestOtpResult | null, FormData>(
    requestOtp,
    null,
  );
  const [verifyState, verifyAction] = useFormState<VerifyOtpResult | null, FormData>(
    verifyOtp,
    null,
  );

  // Once a challenge is issued we move to the code-entry step.
  const challenge = requestState?.ok ? requestState : null;

  useEffect(() => {
    if (verifyState?.ok) {
      router.push('/account/bookings');
    }
  }, [verifyState, router]);

  if (!challenge) {
    return (
      <form action={requestAction} className="space-y-4" noValidate>
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
            We'll email you a one-time sign-in code.
          </p>
        </div>

        {requestState && !requestState.ok && <ErrorAlert message={requestState.error} />}

        <SubmitButton idle="Send my code" busy="Sending…" />
      </form>
    );
  }

  return (
    <CodeStep
      challenge={challenge}
      verifyAction={verifyAction}
      verifyState={verifyState}
    />
  );
}

function CodeStep({
  challenge,
  verifyAction,
  verifyState,
}: {
  challenge: Extract<RequestOtpResult, { ok: true }>;
  verifyAction: (formData: FormData) => void;
  verifyState: VerifyOtpResult | null;
}) {
  const [code, setCode] = useState(challenge.devCode ?? '');

  return (
    <form action={verifyAction} className="space-y-4" noValidate>
      <input type="hidden" name="challenge" value={challenge.challenge} />

      <div>
        <p className="text-sm text-slate-600">
          We sent a 6-digit code to{' '}
          <span className="font-medium text-slate-900">{challenge.email}</span> for
          booking{' '}
          <span className="font-medium text-slate-900">{challenge.orderNumber}</span>.
        </p>
      </div>

      <div>
        <label htmlFor="code" className="mb-1 block text-sm font-medium text-slate-700">
          Sign-in code
        </label>
        <input
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d*"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="123456"
          className="w-full rounded-lg border border-slate-300 px-3 py-3 text-center text-2xl tracking-[0.5em] focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
      </div>

      {challenge.devCode && (
        <div
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800"
        >
          Dev mode: no email provider configured, so your code is{' '}
          <span className="font-mono font-semibold">{challenge.devCode}</span> (prefilled).
        </div>
      )}

      {verifyState && !verifyState.ok && <ErrorAlert message={verifyState.error} />}

      <SubmitButton idle="Verify & continue" busy="Verifying…" />

      <p className="text-center text-xs text-slate-500">
        Didn't get it?{' '}
        <a href="/account" className="font-medium text-brand hover:underline">
          Start over
        </a>
      </p>
    </form>
  );
}
