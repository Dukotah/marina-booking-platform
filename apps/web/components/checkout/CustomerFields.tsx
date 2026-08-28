'use client';

/**
 * Lead-guest (customer) contact fields. Uses the shared react-hook-form context
 * from the checkout form. Field-level validation rules mirror the shared
 * `customerInputSchema` from @marina/core (name/email required; email format).
 *
 * Accessibility: an invalid field carries `aria-invalid` *and* an
 * `aria-describedby` pointing at its own error text, so a guest who tabs back
 * into the field hears why it was rejected rather than only that it was
 * (WCAG 3.3.1 Error Identification).
 */
import { useFormContext } from 'react-hook-form';
import { Input, Label } from '@marina/ui';
import type { CheckoutFormValues } from './types';
import { FieldError } from './FieldError';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The inline error message, in an element with a stable id.
 *
 * `aria-invalid` on its own announces "invalid" and nothing else, which is close
 * to useless — the reason only reaches assistive tech through a resolved
 * `aria-describedby`. The shared `FieldError` renders no id for a caller to
 * point at (it is used on screens outside this one), so the id lives on this
 * wrapper. Rendered only when there is a message, so nothing ever points
 * `aria-describedby` at an empty element.
 */
function DescribedFieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <div id={id}>
      <FieldError message={message} />
    </div>
  );
}

export function CustomerFields() {
  const {
    register,
    formState: { errors },
  } = useFormContext<CheckoutFormValues>();

  const firstNameError = errors.firstName?.message;
  const lastNameError = errors.lastName?.message;
  const emailError = errors.email?.message;
  const phoneError = errors.phone?.message;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="firstName" required>
          First name
        </Label>
        <Input
          id="firstName"
          autoComplete="given-name"
          aria-invalid={firstNameError ? true : undefined}
          aria-describedby={firstNameError ? 'firstName-error' : undefined}
          {...register('firstName', {
            required: 'First name is required',
            maxLength: { value: 80, message: 'Too long' },
          })}
        />
        <DescribedFieldError id="firstName-error" message={firstNameError} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="lastName" required>
          Last name
        </Label>
        <Input
          id="lastName"
          autoComplete="family-name"
          aria-invalid={lastNameError ? true : undefined}
          aria-describedby={lastNameError ? 'lastName-error' : undefined}
          {...register('lastName', {
            required: 'Last name is required',
            maxLength: { value: 80, message: 'Too long' },
          })}
        />
        <DescribedFieldError id="lastName-error" message={lastNameError} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email" required>
          Email
        </Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          aria-invalid={emailError ? true : undefined}
          // The hint below was visually adjacent but programmatically orphaned;
          // it is bound here too. The error is listed first so the reason for the
          // rejection is heard before the standing explanation (3.3.1, 3.3.2).
          aria-describedby={emailError ? 'email-error email-hint' : 'email-hint'}
          {...register('email', {
            required: 'A valid email is required',
            pattern: { value: EMAIL_RE, message: 'A valid email is required' },
          })}
        />
        <DescribedFieldError id="email-error" message={emailError} />
        <p id="email-hint" className="text-xs text-slate-500">
          Your booking confirmation and receipt are sent here.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="phone">Phone</Label>
        <Input
          id="phone"
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          aria-invalid={phoneError ? true : undefined}
          aria-describedby={phoneError ? 'phone-error' : undefined}
          {...register('phone', {
            maxLength: { value: 32, message: 'Too long' },
          })}
        />
        <DescribedFieldError id="phone-error" message={phoneError} />
      </div>
    </div>
  );
}
