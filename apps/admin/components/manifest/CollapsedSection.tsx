'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * A secondary manifest panel, collapsed to one summary row by default.
 *
 * The manifest's job is the day's departures; fleet and guide admin are
 * one-glance/sometimes-tap surfaces that used to render fully expanded and made
 * the page scroll forever. This keeps their headline visible (the summary line
 * IS the glance) and puts the working panel one tap away.
 *
 * A11y: a real <button> with aria-expanded/aria-controls; the controlled
 * container stays mounted (empty when closed) so aria-controls always resolves
 * to an element, the same contract FleetStatus's inline form holds. The chevron
 * is decorative — state rides on aria-expanded, not on the arrow's direction.
 * (4.1.2)
 */
export function CollapsedSection({
  title,
  summary,
  children,
  defaultOpen = false,
}: {
  title: string;
  /** One line of status shown while collapsed (and kept while open). */
  summary: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <h2 id={headingId} className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-4 py-3 text-left hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-500"
        >
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`}
            aria-hidden
          />
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            {title}
          </span>
          <span className="text-sm text-slate-600">{summary}</span>
        </button>
      </h2>

      {/* Mounted-but-empty when closed so aria-controls always resolves. */}
      <div id={panelId}>
        {open ? <div className="border-t border-slate-100 px-4 pb-4 pt-3">{children}</div> : null}
      </div>
    </section>
  );
}
