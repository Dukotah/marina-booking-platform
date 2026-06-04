'use client';

/**
 * Inline liability waiver: a scrollable summary, an acceptance checkbox, and a
 * typed-signature field (the signer's full legal name). Both are required when
 * the activity requires a waiver. The waiver text is operator-neutral here and
 * references the operator by name (white-label — no platform branding).
 *
 * The captured acceptance + typed name flow into the booking so the API can
 * record a waiver signature with an audit trail.
 */
import { useFormContext } from 'react-hook-form';
import { Input, Label } from '@marina/ui';
import type { CheckoutFormValues } from './types';
import { FieldError } from './FieldError';

interface WaiverSectionProps {
  /** Operator name to reference in the waiver copy (from tenant/brand data). */
  operatorName: string;
  /** Activity name the waiver applies to. */
  activityName: string;
}

export function WaiverSection({ operatorName, activityName }: WaiverSectionProps) {
  const {
    register,
    watch,
    formState: { errors },
  } = useFormContext<CheckoutFormValues>();

  const accepted = watch('waiverAccepted');

  return (
    <div className="space-y-4">
      <div className="max-h-44 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
        <p className="mb-2 font-semibold text-slate-700">
          Liability Waiver &amp; Release
        </p>
        <p className="mb-2">
          I acknowledge that participation in <strong>{activityName}</strong> with{' '}
          <strong>{operatorName}</strong> involves inherent risks, including the
          risk of serious injury, property damage, or death. I voluntarily assume
          all such risks.
        </p>
        <p className="mb-2">
          In consideration of being permitted to participate, I release and hold
          harmless {operatorName}, its owners, employees, and agents from any and
          all claims arising out of my participation, to the fullest extent
          permitted by law.
        </p>
        <p>
          I confirm that I am authorized to sign on behalf of all guests in this
          reservation, that the information provided is accurate, and that I have
          read and agree to the terms above.
        </p>
      </div>

      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-300 text-[var(--brand-color)] focus-visible:ring-2 focus-visible:ring-[var(--brand-color,#0f766e)] focus-visible:ring-offset-2"
          aria-invalid={errors.waiverAccepted ? true : undefined}
          {...register('waiverAccepted', {
            required: 'You must accept the waiver to continue',
          })}
        />
        <span className="text-sm text-slate-700">
          I have read and agree to the liability waiver and release.
        </span>
      </label>
      <FieldError message={errors.waiverAccepted?.message} />

      <div className="space-y-1.5">
        <Label htmlFor="signatureName" required>
          Signature (type your full legal name)
        </Label>
        <Input
          id="signatureName"
          autoComplete="name"
          placeholder="Full legal name"
          aria-invalid={errors.signatureName ? true : undefined}
          {...register('signatureName', {
            validate: (value) => {
              if (!accepted) return true; // checkbox error is the primary signal
              return value.trim().length > 0 || 'Please type your full name to sign';
            },
          })}
        />
        <FieldError message={errors.signatureName?.message} />
      </div>
    </div>
  );
}
