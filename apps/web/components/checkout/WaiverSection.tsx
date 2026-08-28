'use client';

/**
 * Inline liability waiver: a scrollable summary, an acceptance checkbox, and a
 * typed-signature field (the signer's full legal name). Both are required when
 * the activity requires a waiver. The waiver text is operator-neutral here and
 * references the operator by name (white-label — no platform branding).
 *
 * The captured acceptance + typed name flow into the booking so the API can
 * record a waiver signature with an audit trail.
 *
 * Accessibility, because this block is where a legal signature is taken:
 * the waiver copy sits in a fixed-height scroller, so it is a named,
 * keyboard-focusable region — otherwise a keyboard or screen-reader user cannot
 * read the text they are about to be bound by (WCAG 2.1.1). The acceptance
 * checkbox has a real id so the checkout error summary can link to it, and both
 * controls bind `aria-describedby` to their own error text (3.3.1).
 */
import { useId } from 'react';
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

export function WaiverSection({ operatorName, activityName }: WaiverSectionProps) {
  const {
    register,
    watch,
    formState: { errors },
  } = useFormContext<CheckoutFormValues>();

  const accepted = watch('waiverAccepted');
  // Names the scrollable waiver region; generated rather than hardcoded because
  // it is only referenced from inside this component.
  const waiverTextTitleId = useId();

  const acceptedError = errors.waiverAccepted?.message;
  const signatureError = errors.signatureName?.message;

  return (
    <div className="space-y-4">
      {/*
        The waiver copy is clipped to `max-h-44`, which makes this a scrollable
        region. Without a tab stop the only way to read past the fold is a mouse
        wheel or a touch drag, so a keyboard user is asked to accept text they
        cannot reach (axe `scrollable-region-focusable`, WCAG 2.1.1). A tab stop
        needs a name and a visible focus indicator to be worth anything: the name
        comes from the waiver's own title, and the ring is slate rather than the
        global brand-coloured outline, which can be invisible against this
        slate-50 panel for a light operator brand (2.4.7, 1.4.11).
      */}
      <div
        role="region"
        aria-labelledby={waiverTextTitleId}
        tabIndex={0}
        className="max-h-44 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
      >
        <p id={waiverTextTitleId} className="mb-2 font-semibold text-slate-700">
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

      {/*
        `htmlFor` as well as wrapping: the wrapper alone still labels the box, but
        the explicit association is what gives the control an id the checkout
        error summary can link to, and what lets a test resolve its label.
      */}
      <label htmlFor="waiverAccepted" className="flex cursor-pointer items-start gap-3">
        <input
          id="waiverAccepted"
          type="checkbox"
          className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-300 text-[var(--brand-color)] focus-visible:ring-2 focus-visible:ring-[var(--brand-color,#0f766e)] focus-visible:ring-offset-2"
          aria-invalid={acceptedError ? true : undefined}
          aria-describedby={acceptedError ? 'waiverAccepted-error' : undefined}
          {...register('waiverAccepted', {
            required: 'You must accept the waiver to continue',
          })}
        />
        <span className="text-sm text-slate-700">
          I have read and agree to the liability waiver and release.
        </span>
      </label>
      <DescribedFieldError id="waiverAccepted-error" message={acceptedError} />

      <div className="space-y-1.5">
        <Label htmlFor="signatureName" required>
          Signature (type your full legal name)
        </Label>
        <Input
          id="signatureName"
          autoComplete="name"
          placeholder="Full legal name"
          aria-invalid={signatureError ? true : undefined}
          aria-describedby={signatureError ? 'signatureName-error' : undefined}
          {...register('signatureName', {
            validate: (value) => {
              if (!accepted) return true; // checkbox error is the primary signal
              return value.trim().length > 0 || 'Please type your full name to sign';
            },
          })}
        />
        <DescribedFieldError id="signatureName-error" message={signatureError} />
      </div>
    </div>
  );
}
