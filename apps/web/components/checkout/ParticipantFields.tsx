'use client';

/**
 * Per-participant detail capture (one block per booked unit). Each driver's name
 * is required (mirrors @marina/core participantInfoSchema); license, date of
 * birth, and experience are optional but validated when present (DOB must be
 * YYYY-MM-DD via the native date input, and not in the future).
 *
 * The number of blocks tracks the booked quantity; the parent keeps the
 * react-hook-form `participants` field array sized to `count`.
 *
 * Accessibility: an invalid field carries `aria-invalid` *and* an
 * `aria-describedby` pointing at its own error text. With several identical
 * driver blocks on the page, "invalid" with no reason attached is not enough to
 * tell a guest which of nine fields to go back to (WCAG 3.3.1).
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

/**
 * The inline error message, in an element with a stable id.
 *
 * The shared `FieldError` renders no id for a caller to point `aria-describedby`
 * at, so the id lives on this wrapper. Rendered only when there is a message, so
 * nothing ever points `aria-describedby` at an empty element.
 */
function DescribedFieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <div id={id}>
      <FieldError message={message} />
    </div>
  );
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
        // Ids match the ones the checkout error summary links to, so every entry
        // in that summary reaches the control it is talking about.
        const nameId = `participant-${i}-name`;
        const licenseId = `participant-${i}-license`;
        const dobId = `participant-${i}-dob`;
        const nameError = fieldErrors?.driver_name?.message;
        const licenseError = fieldErrors?.license?.message;
        const dobError = fieldErrors?.dob?.message;
        return (
          <fieldset
            key={i}
            className="rounded-lg border border-hairline p-4"
          >
            <legend className="px-1 text-sm font-semibold text-ink">
              {count > 1 ? `Driver ${i + 1}` : 'Driver'}
            </legend>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={nameId} required>
                  Full name
                </Label>
                <Input
                  id={nameId}
                  className="rounded-lg border-hairline bg-surface text-ink placeholder:text-muted"
                  autoComplete="name"
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby={nameError ? `${nameId}-error` : undefined}
                  {...register(`participants.${i}.driver_name` as const, {
                    required: 'Driver name is required',
                    maxLength: { value: 120, message: 'Too long' },
                  })}
                />
                <DescribedFieldError id={`${nameId}-error`} message={nameError} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={licenseId}>
                  Driver license #
                </Label>
                <Input
                  id={licenseId}
                  className="rounded-lg border-hairline bg-surface text-ink placeholder:text-muted"
                  aria-invalid={licenseError ? true : undefined}
                  aria-describedby={licenseError ? `${licenseId}-error` : undefined}
                  {...register(`participants.${i}.license` as const, {
                    maxLength: { value: 64, message: 'Too long' },
                  })}
                />
                <DescribedFieldError id={`${licenseId}-error`} message={licenseError} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={dobId}>Date of birth</Label>
                <Input
                  id={dobId}
                  className="tnum rounded-lg border-hairline bg-surface text-ink placeholder:text-muted"
                  type="date"
                  max={max}
                  aria-invalid={dobError ? true : undefined}
                  aria-describedby={dobError ? `${dobId}-error` : undefined}
                  {...register(`participants.${i}.dob` as const, {
                    validate: (value) =>
                      !value || value <= max || 'Date of birth cannot be in the future',
                  })}
                />
                <DescribedFieldError id={`${dobId}-error`} message={dobError} />
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`participant-${i}-experience`}>
                  Boating experience
                </Label>
                <Select
                  id={`participant-${i}-experience`}
                  className="rounded-lg border-hairline bg-surface text-ink placeholder:text-muted"
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
