import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface PageHeaderProps {
  title: string;
  /** Optional supporting line under the title. */
  description?: string;
  /** Right-aligned actions (buttons, filters, etc.). */
  actions?: ReactNode;
  className?: string;
}

/**
 * Consistent page title row used at the top of every admin page. Keeps spacing,
 * type scale, and the title/action layout uniform across slices.
 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        'mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        {/* slate-600, not slate-500: this line sits on the admin page background
            (bg-slate-100 #f1f5f9), where slate-500 measures 4.34:1 — under the 4.5:1
            floor. slate-600 is 6.9:1 on the same ground. (1.4.3) */}
        {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
