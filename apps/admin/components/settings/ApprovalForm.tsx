'use client';

import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import {
  Field,
  TextInput,
  CheckboxRow,
  PrimaryButton,
  SaveStatus,
  SettingsCard,
  type SaveState,
} from './fields';
import {
  updateApprovalSettings,
  type ApprovalInput,
  type ActionResult,
} from '../../app/settings/actions';

export interface ApprovalFormValues {
  approval_threshold_dollars: number | null;
  refund_requires_approval: boolean;
}

/**
 * Manager-approval workflow settings (Singenuity §2). A dollar threshold at/above
 * which any payment or refund needs a manager sign-off, plus an "always require
 * approval for refunds" switch. Enforced server-side in the payment/refund paths.
 */
export function ApprovalForm({ initial }: { initial: ApprovalFormValues }) {
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [isPending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<ApprovalFormValues>({ defaultValues: initial });

  function onSubmit(values: ApprovalFormValues) {
    setSaveState({ kind: 'idle' });
    startTransition(async () => {
      const result: ActionResult = await updateApprovalSettings({
        approval_threshold_dollars:
          values.approval_threshold_dollars === null ||
          Number.isNaN(values.approval_threshold_dollars)
            ? null
            : Number(values.approval_threshold_dollars),
        refund_requires_approval: Boolean(values.refund_requires_approval),
      } as ApprovalInput);
      if (result.ok) {
        setSaveState({ kind: 'saved' });
        return;
      }
      if (result.errors) {
        for (const [path, message] of Object.entries(result.errors)) {
          setError(path as keyof ApprovalFormValues, { message });
        }
      }
      setSaveState({ kind: 'error', message: result.message ?? 'Could not save approval settings.' });
    });
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <SettingsCard
        title="Manager approval"
        description="Require a manager to sign off on larger payments and refunds."
      >
        <div className="space-y-4">
          <Field
            label="Approval threshold ($)"
            htmlFor="approval_threshold_dollars"
            hint="Payments or refunds at or above this amount need a manager (leave blank for no limit)."
            error={errors.approval_threshold_dollars?.message}
          >
            <TextInput
              id="approval_threshold_dollars"
              type="number"
              min={0}
              step="1"
              placeholder="No limit"
              invalid={Boolean(errors.approval_threshold_dollars)}
              {...register('approval_threshold_dollars', {
                setValueAs: (v) => (v === '' || v === null ? null : Number(v)),
                min: { value: 0, message: 'Cannot be negative' },
              })}
            />
          </Field>
          <CheckboxRow
            label="Require manager approval for all refunds"
            description="Every refund needs a manager, regardless of amount."
            {...register('refund_requires_approval')}
          />
        </div>
      </SettingsCard>

      <div className="flex items-center justify-end gap-3">
        <SaveStatus state={saveState} />
        <PrimaryButton type="submit" disabled={isPending || !isDirty}>
          {isPending ? 'Saving…' : 'Save approval settings'}
        </PrimaryButton>
      </div>
    </form>
  );
}
