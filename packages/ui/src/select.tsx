import { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './cn.js';

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/**
 * A styled native `<select>`. Native is intentional: zero extra deps, fully
 * accessible by default, and works inside forms without controlled wiring.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          'flex h-10 w-full appearance-none rounded-md border border-slate-300 bg-white px-3 py-2 pr-9 text-sm text-slate-900 ring-offset-white transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-color,#0f766e)] focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'aria-[invalid=true]:border-red-500 aria-[invalid=true]:focus-visible:ring-red-500',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
        aria-hidden
      />
    </div>
  ),
);
Select.displayName = 'Select';
