'use client';

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../../lib/cn';
import { buttonClasses } from '../ui';

/**
 * Small, dependency-free form primitives shared by the settings + onboarding
 * slices. They sit on the Clean SaaS tokens (surface/line/ink/accent) and forward
 * refs so react-hook-form's `register` works directly. Kept self-contained to this
 * slice so the settings UI has no cross-slice coupling.
 */

export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
        {label}
        {required ? <span className="ml-0.5 text-rose-500">*</span> : null}
      </label>
      {children}
      {hint && !error ? <p className="text-xs text-ink-muted">{hint}</p> : null}
      {error ? <p className="text-xs font-medium text-rose-600">{error}</p> : null}
    </div>
  );
}

const baseControl =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink shadow-sm outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-focus disabled:cursor-not-allowed disabled:opacity-60';

export const TextInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function TextInput({ className, invalid, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        baseControl,
        'h-11',
        invalid && 'border-rose-400 focus:border-rose-500 focus:ring-rose-100',
        className,
      )}
      {...props}
    />
  );
});

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function TextArea({ className, invalid, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(baseControl, 'min-h-[96px] resize-y', invalid && 'border-rose-400', className)}
      {...props}
    />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }
>(function Select({ className, invalid, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn(baseControl, 'h-11', invalid && 'border-rose-400', className)} {...props}>
      {children}
    </select>
  );
});

/** A labelled checkbox row used for toggles. */
export const CheckboxRow = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { label: string; description?: string }
>(function CheckboxRow({ label, description, className, ...props }, ref) {
  return (
    <label
      className={cn(
        'flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line p-3 hover:bg-surface-muted',
        className,
      )}
    >
      <input
        ref={ref}
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-line-strong text-accent accent-accent focus:ring-focus"
        {...props}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {description ? <span className="block text-xs text-ink-body">{description}</span> : null}
      </span>
    </label>
  );
});

/** Primary action button used by settings forms. */
export function PrimaryButton({
  children,
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={buttonClasses('primary', 'md', className)} {...props}>
      {children}
    </button>
  );
}

/** Secondary / outline button. */
export function SecondaryButton({
  children,
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={buttonClasses('secondary', 'md', className)} {...props}>
      {children}
    </button>
  );
}

/** A small inline status message (saved / error) shown next to a save button. */
export function SaveStatus({ state, savedLabel = 'Saved' }: { state: SaveState; savedLabel?: string }) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'saved') {
    return <span className="text-sm font-medium text-emerald-600">{savedLabel}</span>;
  }
  return <span className="text-sm font-medium text-rose-600">{state.message}</span>;
}

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

/** A bordered card section wrapper used throughout settings. */
export function SettingsCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface shadow-sm">
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-ink-body">{description}</p> : null}
      </div>
      <div className="px-5 py-5">{children}</div>
      {footer ? (
        <div className="flex items-center justify-end gap-3 border-t border-line px-5 py-3">
          {footer}
        </div>
      ) : null}
    </section>
  );
}
