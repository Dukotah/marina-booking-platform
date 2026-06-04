'use client';

import Link from 'next/link';
import { cn } from '../../lib/cn';
import { REPORT_KINDS, REPORT_LABEL, type ReportKind } from './kinds';

export interface ReportTabsProps {
  active: ReportKind;
  /** Current range, preserved when switching tabs. */
  from: string;
  to: string;
}

/**
 * Tab strip switching between the revenue, taxes & fees, and occupancy reports.
 * Each tab is a real link that preserves the active date range in the URL, so the
 * report is shareable/bookmarkable and the server re-runs the scoped query.
 */
export function ReportTabs({ active, from, to }: ReportTabsProps) {
  return (
    <div className="border-b border-slate-200">
      <nav className="-mb-px flex gap-6" aria-label="Reports">
        {REPORT_KINDS.map((kind) => {
          const params = new URLSearchParams({ report: kind, from, to });
          const isActive = kind === active;
          return (
            <Link
              key={kind}
              href={`/reports?${params.toString()}`}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors',
                isActive
                  ? 'border-[var(--brand-color,#0ea5e9)] text-slate-900'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700',
              )}
            >
              {REPORT_LABEL[kind]}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
