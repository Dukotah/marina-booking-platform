'use client';

import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { BadgeTone } from './Badge';

export interface StatCardProps {
  /** Plain-English label ("Departures today"). */
  label: string;
  /** Pre-formatted value ("12", "$1,240", "8 of 11"). */
  value: string;
  /** Optional second line under the value. */
  hint?: string;
  icon?: LucideIcon;
  /**
   * Semantic emphasis. `neutral` is the quiet default; a tone tints the icon
   * chip and (when interactive) the selected ring, so a stat that needs
   * attention reads as money/waiver/waiting without shouting.
   */
  tone?: Extract<BadgeTone, 'neutral' | 'accent' | 'owed' | 'waiver' | 'waiting' | 'success'>;
  /** Make the card a button (e.g. the manifest stat filters). */
  onClick?: () => void;
  /** Lit state when used as a toggle filter. */
  selected?: boolean;
  className?: string;
}

const ICON_TONE: Record<NonNullable<StatCardProps['tone']>, string> = {
  neutral: 'bg-surface-muted text-ink-muted',
  accent: 'bg-accent-tint text-accent-ink',
  owed: 'bg-rose-50 text-rose-600',
  waiver: 'bg-amber-50 text-amber-600',
  waiting: 'bg-amber-50 text-amber-600',
  success: 'bg-emerald-50 text-emerald-600',
};

const SELECTED_RING: Record<NonNullable<StatCardProps['tone']>, string> = {
  neutral: 'ring-2 ring-accent',
  accent: 'ring-2 ring-accent',
  owed: 'ring-2 ring-rose-400',
  waiver: 'ring-2 ring-amber-400',
  waiting: 'ring-2 ring-amber-400',
  success: 'ring-2 ring-emerald-400',
};

/**
 * One headline number on a quiet white card. The home "Today" strip is five of
 * these. Pass onClick to turn it into a filter toggle (big 44px+ target).
 */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'neutral',
  onClick,
  selected = false,
  className,
}: StatCardProps) {
  const base = cn(
    'rounded-lg border border-line bg-surface p-4 text-left shadow-sm transition-colors',
    onClick && 'hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
    selected && SELECTED_RING[tone],
    className,
  );

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-ink-body">{label}</span>
        {Icon ? (
          <span className={cn('rounded-lg p-1.5', ICON_TONE[tone])}>
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        ) : null}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-ink tnum">{value}</div>
      {hint ? <div className="mt-1 text-xs text-ink-muted">{hint}</div> : null}
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-pressed={selected} className={cn(base, 'min-h-[88px] w-full')}>
        {body}
      </button>
    );
  }

  return <div className={base}>{body}</div>;
}
