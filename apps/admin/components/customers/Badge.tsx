import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface BadgeProps {
  children: ReactNode;
  className?: string;
}

/**
 * Small neutral pill used to render customer tags consistently across the list
 * and profile pages. Kept deliberately tone-neutral so operator-defined tags
 * never collide with status colors used elsewhere in the admin.
 */
export function Badge({ children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700',
        className,
      )}
    >
      {children}
    </span>
  );
}
