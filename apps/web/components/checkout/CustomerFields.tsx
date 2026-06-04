'use client';

/**
 * Lead-guest (customer) contact fields. Uses the shared react-hook-form context
 * from the checkout form. Field-level validation rules mirror the shared
 * `customerInputSchema` from @marina/core (name/email required; email format).
 */
import { useFormContext } from 'react-hook-form';
import { Input, Label } from '@marina/ui';
import type { CheckoutFormValues } from './types';
import { FieldError } from './FieldError';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CustomerFields() {
  const {
    register,
    formState: { errors },
  } = useFormContext<CheckoutFormValues>();

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="firstName" required>
          First name
        </Label>
        <Input
          id="firstName"
          autoComplete="given-name"
          aria-invalid={errors.firstName ? true : undefined}
          {...register('firstName', {
            required: 'First name is required',
            maxLength: { value: 80, message: 'Too long' },
          })}
        />
        <FieldError message={errors.firstName?.message} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="lastName" required>
          Last name
        </Label>
        <Input
          id="lastName"
          autoComplete="family-name"
          aria-invalid={errors.lastName ? true : undefined}
          {...register('lastName', {
            required: 'Last name is required',
            maxLength: { value: 80, message: 'Too long' },
          })}
        />
        <FieldError message={errors.lastName?.message} />
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
          aria-invalid={errors.email ? true : undefined}
          {...register('email', {
            required: 'A valid email is required',
            pattern: { value: EMAIL_RE, message: 'A valid email is required' },
          })}
        />
        <FieldError message={errors.email?.message} />
        <p className="text-xs text-slate-500">
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
          aria-invalid={errors.phone ? true : undefined}
          {...register('phone', {
            maxLength: { value: 32, message: 'Too long' },
          })}
        />
        <FieldError message={errors.phone?.message} />
      </div>
    </div>
  );
}
