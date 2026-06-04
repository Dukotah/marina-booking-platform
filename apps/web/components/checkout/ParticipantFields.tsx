'use client';

/**
 * Per-participant detail capture (one block per booked unit). Each driver's name
 * is required (mirrors @marina/core participantInfoSchema); license, date of
 * birth, and experience are optional but validated when present (DOB must be
 * YYYY-MM-DD via the native date input, and not in the future).
 *
 * The number of blocks tracks the booked quantity; the parent keeps the
 * react-hook-form `participants` field array sized to `count`.
 */
import { useFormContext } from 'react-hook-form';
import { Input, Label, Select } from '@marina/ui';
import type { CheckoutFormValues } from './types';
import { FieldError } from './FieldError';

interface ParticipantFieldsProps {
  count: number;
}

const EXPERIENCE_OPTIONS: Array<{
  value: CheckoutFormValues['participants'][number]['experience'];
  label: string;
}> = [
  { value: '', label: 'Select (optional)' },
  { value: 'NONE', label: 'None' },
  { value: 'BEGINNER', label: 'Beginner' },
  { value: 'INTERMEDIATE', label: 'Intermediate' },
  { value: 'EXPERIENCED', label: 'Experienced' },
];

/** Today's date as YYYY-MM-DD, used to cap the DOB date input. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ParticipantFields({ count }: ParticipantFieldsProps) {
  const {
    register,
    formState: { errors },
  } = useFormContext<CheckoutFormValues>();

  const indices = Array.from({ length: count }, (_, i) => i);
  const max = todayISO();

  return (
    <div className="space-y-5">
      {indices.map((i) => {
        const fieldErrors = errors.participants?.[i];
        return (
          <fieldset
            key={i}
            className="rounded-lg border border-slate-200 p-4"
          >
            <legend className="px-1 text-sm font-semibold text-slate-700">
              {count > 1 ? `Driver ${i + 1}` : 'Driver'}
            </legend>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`participant-${i}-name`} required>
                  Full name
                </Label>
                <Input
                  id={`participant-${i}-name`}
                  autoComplete="name"
                  aria-invalid={fieldErrors?.driver_name ? true : undefined}
                  {...register(`participants.${i}.driver_name` as const, {
                    required: 'Driver name is required',
                    maxLength: { value: 120, message: 'Too long' },
                  })}
                />
                <FieldError message={fieldErrors?.driver_name?.message} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={`participant-${i}-license`}>
                  Driver license #
                </Label>
                <Input
                  id={`participant-${i}-license`}
                  aria-invalid={fieldErrors?.license ? true : undefined}
                  {...register(`participants.${i}.license` as const, {
                    maxLength: { value: 64, message: 'Too long' },
                  })}
                />
                <FieldError message={fieldErrors?.license?.message} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={`participant-${i}-dob`}>Date of birth</Label>
                <Input
                  id={`participant-${i}-dob`}
                  type="date"
                  max={max}
                  aria-invalid={fieldErrors?.dob ? true : undefined}
                  {...register(`participants.${i}.dob` as const, {
                    validate: (value) =>
                      !value || value <= max || 'Date of birth cannot be in the future',
                  })}
                />
                <FieldError message={fieldErrors?.dob?.message} />
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`participant-${i}-experience`}>
                  Boating experience
                </Label>
                <Select
                  id={`participant-${i}-experience`}
                  {...register(`participants.${i}.experience` as const)}
                >
                  {EXPERIENCE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
