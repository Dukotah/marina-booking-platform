import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * Semantic tones. Each maps a MEANING to a muted tinted chip (bg-*-50/100
 * text-*-700). Keep these consistent app-wide — do NOT invent per-page colors.
 *
 *   neutral  — default / informational (slate)
 *   accent   — the teal accent (use sparingly, for a highlighted count)
 *   owed     — money owed            (rose)
 *   waiver   — waiver needed         (amber)
 *   waiting  — waiting / waitlist    (amber)
 *   success  — checked-in / done     (emerald)
 *   cancelled— cancelled / inactive  (slate)
 */
export type BadgeTone =
  | 'neutral'
  | 'accent'
  | 'owed'
  | 'waiver'
  | 'waiting'
  | 'success'
  | 'cancelled';

export const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  accent: 'bg-accent-tint text-accent-ink',
  owed: 'bg-rose-50 text-rose-700',
  waiver: 'bg-amber-50 text-amber-700',
  waiting: 'bg-amber-50 text-amber-700',
  success: 'bg-emerald-50 text-emerald-700',
  cancelled: 'bg-slate-100 text-slate-500',
};

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}

/**
 * Small rounded-full chip for status / tags / counts. Quiet by default
 * (neutral). Reach for a tone only when it carries meaning.
 */
export function Badge({ children, tone = 'neutral', className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
