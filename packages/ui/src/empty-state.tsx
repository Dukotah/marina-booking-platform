import { forwardRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from './cn.js';

export interface EmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Optional lucide icon shown above the title. */
  icon?: LucideIcon;
  /** Primary heading. */
  title: React.ReactNode;
  /** Supporting description. */
  description?: React.ReactNode;
  /** Optional call-to-action (e.g. a Button). */
  action?: React.ReactNode;
}

/** A centered placeholder for empty lists, dashboards, and search results. */
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(
  ({ className, icon: Icon, title, description, action, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50/50 px-6 py-12 text-center',
        className,
      )}
      {...props}
    >
      {Icon ? (
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <Icon className="h-6 w-6" aria-hidden />
        </span>
      ) : null}
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        {description ? (
          <p className="max-w-sm text-sm text-slate-500">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  ),
);
EmptyState.displayName = 'EmptyState';
