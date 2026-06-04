import { forwardRef } from 'react';
import { cn } from './cn.js';

export interface LabelProps
  extends React.LabelHTMLAttributes<HTMLLabelElement> {
  /** Render a red asterisk to mark the associated field as required. */
  required?: boolean;
}

export const Label = forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, required, children, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(
        'text-sm font-medium leading-none text-slate-900 peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className,
      )}
      {...props}
    >
      {children}
      {required ? (
        <span className="ml-0.5 text-red-500" aria-hidden>
          *
        </span>
      ) : null}
    </label>
  ),
);
Label.displayName = 'Label';
