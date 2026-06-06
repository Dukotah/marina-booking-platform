'use client';

import { useState, useTransition, useCallback, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { cn } from '../../lib/cn';
import { checkSlug, createAccount, type SlugCheckResult } from './actions';

// ---------------------------------------------------------------------------
// Inline form primitives (no cross-slice import from settings/fields — this
// page is pre-tenant and standalone, but we mirror the same visual language).
// ---------------------------------------------------------------------------

const baseInput =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 disabled:cursor-not-allowed disabled:bg-slate-50';

function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: React.ReactNode;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </label>
      {children}
      {hint && !error ? <p className="text-xs text-slate-400">{hint}</p> : null}
      {error ? <p className="text-xs font-medium text-rose-600">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slug status indicator
// ---------------------------------------------------------------------------

type SlugStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; slug: string; suggestion?: string }
  | { kind: 'taken'; slug: string; suggestion?: string }
  | { kind: 'unknown' };

function SlugIndicator({
  status,
  bookingDomain,
}: {
  status: SlugStatus;
  bookingDomain: string;
}) {
  if (status.kind === 'idle') return null;

  if (status.kind === 'checking') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-slate-400">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-500" />
        Checking availability…
      </p>
    );
  }

  if (status.kind === 'available') {
    return (
      <p className="text-xs font-medium text-emerald-600">
        Available — your site will be at{' '}
        <span className="font-semibold">
          {status.slug}.{bookingDomain}
        </span>
      </p>
    );
  }

  if (status.kind === 'taken') {
    return (
      <div className="text-xs font-medium text-rose-600">
        <p>
          <span className="font-semibold">
            {status.slug}.{bookingDomain}
          </span>{' '}
          is already taken.
        </p>
        {status.suggestion && (
          <p className="mt-0.5 text-slate-500">
            Try:{' '}
            <span className="font-semibold text-slate-700">
              {status.suggestion}.{bookingDomain}
            </span>
          </p>
        )}
      </div>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Slug derivation helper
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

// ---------------------------------------------------------------------------
// Form values
// ---------------------------------------------------------------------------

interface FormValues {
  businessName: string;
  ownerName: string;
  ownerEmail: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Standalone signup form. Pre-tenant — no Clerk session, no AdminShell.
 *
 * The slug field auto-derives from businessName and shows a debounced live
 * availability check via the `checkSlug` server action. If the user edits the
 * slug manually, auto-derivation stops.
 */
export function SignupForm() {
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [slugStatus, setSlugStatus] = useState<SlugStatus>({ kind: 'idle' });

  // Track whether the user has manually edited the slug field.
  const slugManualRef = useRef(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: { businessName: '', ownerName: '', ownerEmail: '', slug: '' },
  });

  const businessName = watch('businessName');
  const slugValue = watch('slug');

  // Booking domain shown in the slug preview. White-label placeholder — swap for
  // the real domain once the platform domain is decided.
  const BOOKING_DOMAIN = 'bookingapp.io';

  // --- Debounced slug check ---
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSlugCheck = useCallback((raw: string) => {
    if (checkTimer.current) clearTimeout(checkTimer.current);
    const slug = raw.trim();
    if (!slug) {
      setSlugStatus({ kind: 'idle' });
      return;
    }
    setSlugStatus({ kind: 'checking' });
    checkTimer.current = setTimeout(async () => {
      const result: SlugCheckResult | null = await checkSlug(slug);
      if (!result) {
        setSlugStatus({ kind: 'unknown' });
        return;
      }
      if (result.available) {
        setSlugStatus({ kind: 'available', slug: result.slug, suggestion: result.suggestion });
      } else {
        setSlugStatus({ kind: 'taken', slug: result.slug, suggestion: result.suggestion });
      }
    }, 450);
  }, []);

  // --- Auto-derive slug from business name (unless manually edited) ---
  useEffect(() => {
    if (slugManualRef.current) return;
    const derived = slugify(businessName);
    setValue('slug', derived, { shouldValidate: false });
    scheduleSlugCheck(derived);
  }, [businessName, setValue, scheduleSlugCheck]);

  // --- Trigger check when slug field changes directly ---
  useEffect(() => {
    // Only schedule when the user is actively editing the slug field.
    // The auto-derive path above also calls scheduleSlugCheck, so this
    // effect only fires for manual edits (slugManualRef.current === true).
    if (!slugManualRef.current) return;
    scheduleSlugCheck(slugValue);
  }, [slugValue, scheduleSlugCheck]);

  // --- Submit ---
  function onSubmit(values: FormValues) {
    setServerError(null);
    startTransition(async () => {
      const result = await createAccount({
        businessName: values.businessName,
        ownerName: values.ownerName || undefined,
        ownerEmail: values.ownerEmail,
        slug: values.slug || undefined,
      });

      // `createAccount` redirects on success — we only get here on error.
      if (!result.ok) {
        setServerError(result.error);
        if (result.fieldErrors) {
          for (const [field, message] of Object.entries(result.fieldErrors)) {
            setError(field as keyof FormValues, { message });
          }
        }
      }
    });
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      {/* Business name */}
      <Field
        label="Business name"
        htmlFor="businessName"
        required
        error={errors.businessName?.message}
        hint="Your trading name as customers will see it."
      >
        <input
          id="businessName"
          autoComplete="organization"
          placeholder="Sunrise Marina"
          className={cn(baseInput, errors.businessName && 'border-rose-400 focus:border-rose-500 focus:ring-rose-100')}
          {...register('businessName', {
            required: 'Business name is required',
            minLength: { value: 2, message: 'Business name must be at least 2 characters' },
            maxLength: { value: 160, message: 'Business name is too long' },
          })}
        />
      </Field>

      {/* URL slug */}
      <Field
        label="Your booking URL"
        htmlFor="slug"
        error={errors.slug?.message}
        hint={
          <SlugIndicator status={slugStatus} bookingDomain={BOOKING_DOMAIN} />
        }
      >
        <div className="flex items-center gap-0">
          <input
            id="slug"
            autoComplete="off"
            placeholder="sunrise-marina"
            className={cn(
              baseInput,
              'rounded-r-none border-r-0',
              errors.slug && 'border-rose-400 focus:border-rose-500 focus:ring-rose-100',
            )}
            {...register('slug', {
              maxLength: { value: 63, message: 'Slug is too long' },
              pattern: {
                value: /^[a-z0-9-]*$/,
                message: 'Only lowercase letters, numbers, and hyphens',
              },
              onChange: () => {
                slugManualRef.current = true;
              },
            })}
          />
          <span className="flex h-[38px] shrink-0 items-center rounded-r-lg border border-slate-300 bg-slate-50 px-3 text-xs font-medium text-slate-500 shadow-sm">
            .{BOOKING_DOMAIN}
          </span>
        </div>
      </Field>

      {/* Owner name */}
      <Field
        label="Your name"
        htmlFor="ownerName"
        error={errors.ownerName?.message}
        hint="Optional — used for your admin account."
      >
        <input
          id="ownerName"
          autoComplete="name"
          placeholder="Alex Smith"
          className={cn(baseInput, errors.ownerName && 'border-rose-400 focus:border-rose-500 focus:ring-rose-100')}
          {...register('ownerName', {
            maxLength: { value: 160, message: 'Name is too long' },
          })}
        />
      </Field>

      {/* Owner email */}
      <Field
        label="Email address"
        htmlFor="ownerEmail"
        required
        error={errors.ownerEmail?.message}
        hint="Used to log in and receive booking notifications."
      >
        <input
          id="ownerEmail"
          type="email"
          autoComplete="email"
          placeholder="you@yourbusiness.com"
          className={cn(baseInput, errors.ownerEmail && 'border-rose-400 focus:border-rose-500 focus:ring-rose-100')}
          {...register('ownerEmail', {
            required: 'Email address is required',
            pattern: {
              value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
              message: 'Enter a valid email address',
            },
          })}
        />
      </Field>

      {/* Server error banner */}
      {serverError && (
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
        >
          {serverError}
        </div>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? 'Creating your account…' : 'Create my booking site'}
      </button>

      <p className="text-center text-xs text-slate-400">
        By continuing you agree to our terms of service and privacy policy.
      </p>
    </form>
  );
}
