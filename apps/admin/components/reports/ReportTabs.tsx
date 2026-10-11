'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { cn } from '../../lib/cn';
import { REPORT_KINDS, REPORT_LABEL, type ReportKind } from './kinds';

export interface ReportTabsProps {
  /** 'locations' = the multi-location roll-up page, a sibling of the report kinds
   *  since Locations left the sidebar and became a Reports tab (2026-09). */
  active: ReportKind | 'locations';
  /** Current range, preserved when switching tabs. */
  from: string;
  to: string;
}

/**
 * Tab strip switching between the report kinds. Each tab is a real link that
 * preserves the active date range AND the shared controls (basis, compare,
 * activity filter) in the URL, so switching tabs never resets the operator's
 * context — shareable and bookmarkable, the server re-runs the scoped query.
 * The sales sub-view (`view`) is sales-specific and is dropped when leaving.
 */
export function ReportTabs({ active, from, to }: ReportTabsProps) {
  const searchParams = useSearchParams();

  return (
    <div className="border-b border-line">
      <nav className="-mb-px flex gap-6 overflow-x-auto" aria-label="Reports">
        {REPORT_KINDS.map((kind) => {
          const params = new URLSearchParams(searchParams.toString());
          params.set('report', kind);
          params.set('from', from);
          params.set('to', to);
          if (kind !== 'sales') params.delete('view');
          const isActive = kind === active;
          return (
            <Link
              key={kind}
              href={`/reports?${params.toString()}`}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors',
                isActive
                  ? 'border-accent text-accent-ink'
                  : 'border-transparent text-ink-body hover:border-line-strong hover:text-ink',
              )}
            >
              {REPORT_LABEL[kind]}
            </Link>
          );
        })}
        {/* Locations roll-up lives on its own route (different query set), but the
            operator reads it as one more report tab. Only from/to travel with it. */}
        <Link
          href={`/reports/locations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`}
          aria-current={active === 'locations' ? 'page' : undefined}
          className={cn(
            'inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors',
            active === 'locations'
              ? 'border-accent text-accent-ink'
              : 'border-transparent text-ink-body hover:border-line-strong hover:text-ink',
          )}
        >
          Locations
        </Link>
      </nav>
    </div>
  );
}
