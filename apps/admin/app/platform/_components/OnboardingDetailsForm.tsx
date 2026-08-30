'use client';

import { useEffect, useRef } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { saveOnboardingDetailsAction, type PlatformResult } from '../actions';

const FIELD =
  'mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500';
const LABEL = 'block text-xs font-medium uppercase tracking-wide text-slate-400';

export interface OnboardingDetailsValues {
  owner: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  /** YYYY-MM-DD for the date input, or '' when no date has been set. */
  targetLiveOn: string;
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
    >
      {pending ? 'Saving…' : 'Save details'}
    </button>
  );
}

/**
 * Who owns this client on our side, who to ring on theirs, and the date we are
 * working towards. All three live next to the stage control because they are the
 * fields the owner updates in the same thirty seconds after a phone call.
 */
export function OnboardingDetailsForm({
  operatorId,
  values,
}: {
  operatorId: string;
  values: OnboardingDetailsValues;
}) {
  const action = saveOnboardingDetailsAction.bind(null, operatorId);
  const [state, formAction] = useFormState<PlatformResult | null, FormData>(action, null);
  const router = useRouter();
  const savedRef = useRef<PlatformResult | null>(null);

  useEffect(() => {
    if (state?.ok && state !== savedRef.current) {
      savedRef.current = state;
      router.refresh();
    }
  }, [state, router]);

  const e = state?.errors ?? {};

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="owner">
            Who owns this on our side
          </label>
          <input
            id="owner"
            name="owner"
            className={FIELD}
            defaultValue={values.owner}
            placeholder="e.g. Duke"
            autoComplete="off"
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="target_live_on">
            Target go-live date
          </label>
          <input
            id="target_live_on"
            name="target_live_on"
            type="date"
            className={FIELD}
            defaultValue={values.targetLiveOn}
            aria-invalid={e.target_live_on ? true : undefined}
            aria-describedby={e.target_live_on ? 'target_live_on-error' : undefined}
          />
          <FieldError id="target_live_on-error" msg={e.target_live_on} />
        </div>
        <div>
          <label className={LABEL} htmlFor="contact_name">
            Their contact
          </label>
          <input
            id="contact_name"
            name="contact_name"
            className={FIELD}
            defaultValue={values.contactName}
            placeholder="Name at the marina"
            autoComplete="off"
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="contact_phone">
            Their phone
          </label>
          <input
            id="contact_phone"
            name="contact_phone"
            type="tel"
            className={FIELD}
            defaultValue={values.contactPhone}
            autoComplete="off"
          />
        </div>
        <div className="sm:col-span-2">
          <label className={LABEL} htmlFor="contact_email">
            Their email
          </label>
          <input
            id="contact_email"
            name="contact_email"
            type="email"
            className={FIELD}
            defaultValue={values.contactEmail}
            aria-invalid={e.contact_email ? true : undefined}
            aria-describedby={e.contact_email ? 'contact_email-error' : undefined}
            autoComplete="off"
          />
          <FieldError id="contact_email-error" msg={e.contact_email} />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Submit />
        {state?.ok && (
          <p aria-live="polite" className="text-sm text-emerald-300">
            Saved.
          </p>
        )}
        {state && !state.ok && state.message && (
          <p role="alert" className="text-sm text-rose-300">
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}

function FieldError({ id, msg }: { id: string; msg?: string }) {
  if (!msg) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-rose-300">
      {msg}
    </p>
  );
}
