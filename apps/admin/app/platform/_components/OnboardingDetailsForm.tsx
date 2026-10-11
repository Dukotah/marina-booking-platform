'use client';

import { useEffect, useRef } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { saveOnboardingDetailsAction, type PlatformResult } from '../actions';
import { Button, Input, FieldLabel } from '../../../components/ui';

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
    <Button type="submit" variant="primary" size="md" disabled={pending}>
      {pending ? 'Saving…' : 'Save details'}
    </Button>
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
          <FieldLabel htmlFor="owner">Who owns this on our side</FieldLabel>
          <Input
            id="owner"
            name="owner"
            defaultValue={values.owner}
            placeholder="e.g. Duke"
            autoComplete="off"
          />
        </div>
        <div>
          <FieldLabel htmlFor="target_live_on">Target go-live date</FieldLabel>
          <Input
            id="target_live_on"
            name="target_live_on"
            type="date"
            defaultValue={values.targetLiveOn}
            aria-invalid={e.target_live_on ? true : undefined}
            aria-describedby={e.target_live_on ? 'target_live_on-error' : undefined}
          />
          <FieldError id="target_live_on-error" msg={e.target_live_on} />
        </div>
        <div>
          <FieldLabel htmlFor="contact_name">Their contact</FieldLabel>
          <Input
            id="contact_name"
            name="contact_name"
            defaultValue={values.contactName}
            placeholder="Name at the marina"
            autoComplete="off"
          />
        </div>
        <div>
          <FieldLabel htmlFor="contact_phone">Their phone</FieldLabel>
          <Input
            id="contact_phone"
            name="contact_phone"
            type="tel"
            defaultValue={values.contactPhone}
            autoComplete="off"
          />
        </div>
        <div className="sm:col-span-2">
          <FieldLabel htmlFor="contact_email">Their email</FieldLabel>
          <Input
            id="contact_email"
            name="contact_email"
            type="email"
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
          <p aria-live="polite" className="text-sm text-emerald-700">
            Saved.
          </p>
        )}
        {state && !state.ok && state.message && (
          <p role="alert" className="text-sm text-rose-700">
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
    <p id={id} role="alert" className="mt-1 text-xs text-rose-700">
      {msg}
    </p>
  );
}
