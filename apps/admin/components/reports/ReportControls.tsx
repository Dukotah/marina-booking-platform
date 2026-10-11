'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { CalendarClock, GitCompareArrows, Sailboat } from 'lucide-react';
import { cn } from '../../lib/cn';
import {
  REPORT_CONTROLS,
  SALES_VIEWS,
  SALES_VIEW_LABEL,
  type ReportKind,
  type SalesView,
} from './kinds';

export interface ReportControlsProps {
  reportKind: ReportKind;
  /** Active date basis. */
  basis: 'order' | 'appointment';
  /** Whether comparison-vs-prior-period is on. */
  compare: boolean;
  /** Active activity filter (id), or null. */
  activityId: string | null;
  /** Activity catalog for the filter dropdown. */
  activities: Array<{ id: string; name: string }>;
  /** Active sales sub-view (rendered on the Sales tab only). */
  view?: SalesView;
}

/**
 * Shared report controls, consistent across tabs where the data honestly
 * supports them (see REPORT_CONTROLS): date-basis toggle (order vs appointment
 * date), activity filter ("orders including this activity"), comparison
 * toggle (vs the immediately-preceding period of equal length), and — on the
 * Sales tab — the Summary / Items / Details view switch. Everything writes to
 * the URL search params so the server component re-runs the tenant-scoped
 * query — shareable and bookmarkable, no client state to drift.
 */
export function ReportControls({
  reportKind,
  basis,
  compare,
  activityId,
  activities,
  view,
}: ReportControlsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const controls = REPORT_CONTROLS[reportKind];

  function setParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null) params.delete(key);
    else params.set(key, value);
    startTransition(() => {
      router.push(`/reports?${params.toString()}`);
    });
  }

  const showViewToggle = reportKind === 'sales';
  if (!controls.basis && !controls.compare && !controls.activity && !showViewToggle) return null;

  return (
    <div className="flex flex-wrap items-center gap-4">
      {showViewToggle ? (
        <div
          role="group"
          aria-label="Sales view"
          className="inline-flex overflow-hidden rounded-lg border border-line"
        >
          {SALES_VIEWS.map((v) => (
            <SegmentButton
              key={v}
              active={view === v}
              disabled={isPending}
              onClick={() => setParam('view', v === 'summary' ? null : v)}
            >
              {SALES_VIEW_LABEL[v]}
            </SegmentButton>
          ))}
        </div>
      ) : null}

      {controls.basis ? (
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-ink-body">
            <CalendarClock className="h-3.5 w-3.5" aria-hidden />
            Date basis
          </span>
          <div
            role="group"
            aria-label="Date basis"
            className="inline-flex overflow-hidden rounded-lg border border-line"
          >
            <SegmentButton
              active={basis === 'order'}
              disabled={isPending}
              onClick={() => setParam('basis', 'order')}
            >
              Order date
            </SegmentButton>
            <SegmentButton
              active={basis === 'appointment'}
              disabled={isPending}
              onClick={() => setParam('basis', 'appointment')}
            >
              Appointment date
            </SegmentButton>
          </div>
        </div>
      ) : null}

      {controls.activity ? (
        <label className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-ink-body">
            <Sailboat className="h-3.5 w-3.5" aria-hidden />
            Activity
          </span>
          <select
            value={activityId ?? ''}
            disabled={isPending}
            onChange={(e) => setParam('activity', e.target.value || null)}
            className="h-11 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium text-ink-body focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus"
          >
            <option value="">All activities</option>
            {activities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {controls.compare ? (
        <button
          type="button"
          aria-pressed={compare}
          disabled={isPending}
          onClick={() => setParam('compare', compare ? null : '1')}
          className={cn(
            'inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors',
            compare
              ? 'border-accent bg-accent-tint text-accent-ink'
              : 'border-line text-ink-body hover:border-line-strong hover:text-ink',
          )}
        >
          <GitCompareArrows className="h-3.5 w-3.5" aria-hidden />
          Compare to previous period
        </button>
      ) : null}
    </div>
  );
}

function SegmentButton({
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
        'min-h-11 px-3 text-xs font-medium transition-colors',
        active
          ? 'bg-accent text-white'
          : 'bg-surface text-ink-body hover:bg-surface-muted',
      )}
    >
      {children}
    </button>
  );
}
