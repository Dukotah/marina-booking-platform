'use client';

import { cn } from '../../lib/cn';

export interface GiftCardStatusBadgeProps {
  isActive: boolean;
  className?: string;
}

/**
 * Small status pill: green "Active" or red "Voided".
 * Matches the OrderStatusBadge aesthetic (dot + label).
 */
export function GiftCardStatusBadge({ isActive, className }: GiftCardStatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        isActive
          ? 'bg-emerald-50 text-emerald-700'
          : 'bg-red-50 text-red-700',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          isActive ? 'bg-emerald-500' : 'bg-red-500',
        )}
      />
      {isActive ? 'Active' : 'Voided'}
    </span>
  );
}
