'use client';

import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import {
  Field,
  TextInput,
  TextArea,
  Select,
  PrimaryButton,
  SaveStatus,
  SettingsCard,
  type SaveState,
} from './fields';
import { updatePolicies, type PoliciesInput, type ActionResult } from '../../app/settings/actions';

export interface PoliciesFormValues {
  legal_adult_age: number;
  timezone: string;
  cancellation_policy: string;
  checkin_instructions: string;
}

/** A pragmatic set of US-centric timezones; operators can have more added later. */
const TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Phoenix',
  'America/Chicago',
  'America/New_York',
  'America/Anchorage',
  'Pacific/Honolulu',
] as const;

/**
 * Policy editor: legal adult age + timezone (first-class operator columns) plus
 * free-form cancellation and check-in copy persisted via a "policies" config
 * record (no schema churn). The adult age drives minor-waiver handling elsewhere.
 */
export function PoliciesForm({ initial }: { initial: PoliciesFormValues }) {
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [isPending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<PoliciesFormValues>({ defaultValues: initial });

  function onSubmit(values: PoliciesFormValues) {
    setSaveState({ kind: 'idle' });
    startTransition(async () => {
      const result: ActionResult = await updatePolicies(values as unknown as PoliciesInput);
      if (result.ok) {
        setSaveState({ kind: 'saved' });
        return;
      }
      if (result.errors) {
        for (const [path, message] of Object.entries(result.errors)) {
          setError(path as keyof PoliciesFormValues, { message });
        }
      }
      setSaveState({ kind: 'error', message: result.message ?? 'Could not save policies.' });
    });
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <SettingsCard
        title="Booking rules"
        description="Operational defaults that apply across your activities."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Legal adult age"
            htmlFor="legal_adult_age"
            required
            hint="Guests below this age are treated as minors for waivers."
            error={errors.legal_adult_age?.message}
          >
            <TextInput
              id="legal_adult_age"
              type="number"
              min={13}
              max={25}
              invalid={Boolean(errors.legal_adult_age)}
              {...register('legal_adult_age', {
                valueAsNumber: true,
                required: 'Adult age is required',
                min: { value: 13, message: 'Seems too low' },
                max: { value: 25, message: 'Seems too high' },
              })}
            />
          </Field>
          <Field label="Timezone" htmlFor="timezone" required error={errors.timezone?.message}>
            <Select id="timezone" invalid={Boolean(errors.timezone)} {...register('timezone', { required: true })}>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Policy copy"
        description="Shown to guests at checkout and in confirmation emails."
      >
        <div className="space-y-4">
          <Field
            label="Cancellation policy"
            htmlFor="cancellation_policy"
            hint="e.g. Free cancellation up to 48 hours before your booking."
            error={errors.cancellation_policy?.message}
          >
            <TextArea
              id="cancellation_policy"
              placeholder="Describe your cancellation and refund terms…"
              {...register('cancellation_policy')}
            />
          </Field>
          <Field
            label="Check-in instructions"
            htmlFor="checkin_instructions"
            hint="Where and when to arrive, what to bring, etc."
            error={errors.checkin_instructions?.message}
          >
            <TextArea
              id="checkin_instructions"
              placeholder="Tell guests how to check in on arrival…"
              {...register('checkin_instructions')}
            />
          </Field>
        </div>
      </SettingsCard>

      <div className="flex items-center justify-end gap-3">
        <SaveStatus state={saveState} />
        <PrimaryButton type="submit" disabled={isPending || !isDirty}>
          {isPending ? 'Saving…' : 'Save policies'}
        </PrimaryButton>
      </div>
    </form>
  );
}
