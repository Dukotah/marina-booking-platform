import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SectionCardProps {
  title: string;
  /** Optional supporting line under the section title. */
  description?: string;
  /** Optional right-aligned content in the header (e.g. a count badge). */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * A titled card used to frame each dashboard panel (trend, occupancy, alerts,
 * upcoming). Keeps section spacing and the header layout uniform across panels.
 */
export function SectionCard({
  title,
  description,
  aside,
  className,
  children,
}: SectionCardProps) {
  return (
    <section
      className={cn(
        'rounded-xl border border-slate-200 bg-white p-5 shadow-sm',
        className,
      )}
    >
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight text-slate-900">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-sm text-slate-500">{description}</p>
          ) : null}
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}
