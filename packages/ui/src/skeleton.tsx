import { forwardRef } from 'react';
import { cn } from './cn.js';

/** A pulsing placeholder block to show while content loads. */
export const Skeleton = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    aria-hidden
    className={cn('animate-pulse rounded-md bg-slate-200', className)}
    {...props}
  />
));
Skeleton.displayName = 'Skeleton';
