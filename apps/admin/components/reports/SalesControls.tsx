'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { CalendarClock, GitCompareArrows } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface SalesControlsProps {
  /** Active date basis. */
  basis: 'order' | 'appointment';
  /** Whether comparison-vs-prior-period is on. */
  compare: boolean;
}

/**
 * Sales-report controls: the date-basis toggle (report by order/created date vs
 * appointment/slot date) and the comparison toggle (vs the immediately-preceding
 * period of equal length). Both write to the URL search params so the server
 * component re-runs the tenant-scoped query — shareable and bookmarkable, no
 * client state to drift.
 */
export function SalesControls({ basis, compare }: SalesControlsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function setParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null) params.delete(key);
    else params.set(key, value);
    startTransition(() => {
      router.push(`/reports?${params.toString()}`);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
          <CalendarClock className="h-3.5 w-3.5" aria-hidden />
          Date basis
        </span>
        <div
          role="group"
          aria-label="Date basis"
          className="inline-flex overflow-hidden rounded-md border border-slate-200"
        >
          <BasisButton
            active={basis === 'order'}
            disabled={isPending}
            onClick={() => setParam('basis', 'order')}
          >
            Order date
          </BasisButton>
          <BasisButton
            active={basis === 'appointment'}
            disabled={isPending}
            onClick={() => setParam('basis', 'appointment')}
          >
            Appointment date
          </BasisButton>
        </div>
      </div>

      <button
        type="button"
        aria-pressed={compare}
        disabled={isPending}
        onClick={() => setParam('compare', compare ? null : '1')}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
          compare
            ? 'border-[var(--brand-color,#0ea5e9)] bg-[var(--brand-color,#0ea5e9)]/10 text-slate-900'
            : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-900',
        )}
      >
        <GitCompareArrows className="h-3.5 w-3.5" aria-hidden />
        Compare to previous period
      </button>
    </div>
  );
}

function BasisButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-[var(--brand-color,#0ea5e9)] text-white'
          : 'bg-white text-slate-600 hover:bg-slate-50',
      )}
    >
      {children}
    </button>
  );
}
