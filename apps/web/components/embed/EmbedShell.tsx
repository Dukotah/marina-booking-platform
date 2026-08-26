'use client';

/**
 * Chrome for the embedded flow: a slim bar with back navigation, the operator's
 * name, and (in modal mode) a close button.
 *
 * This is the only UI the embed adds on top of the reused booking components. It
 * stays deliberately thin — the customer is on the operator's own website, so the
 * widget should read as part of it, not as a second site inside a box.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { isFramed, postToHost } from './protocol';
import type { EmbedSessionParams, EmbedStep } from './params';

interface EmbedShellProps {
  session: EmbedSessionParams;
  step: EmbedStep;
  /** Operator (white-label) name shown in the bar. */
  brandName: string;
  /** Where "back" goes, or null when this step is the widget's entry point. */
  backHref: string | null;
  backLabel: string;
  children: React.ReactNode;
}

const STEP_TITLES: Record<EmbedStep, string> = {
  catalog: 'Book online',
  activity: 'Choose your time',
  checkout: 'Checkout',
  confirmation: 'Confirmed',
};

export function EmbedShell({
  session,
  step,
  brandName,
  backHref,
  backLabel,
  children,
}: EmbedShellProps) {
  // Only a real host page can act on "close". Opening /embed directly in a tab —
  // which is how you test an install — would otherwise show a dead button.
  const [standalone, setStandalone] = useState(false);
  useEffect(() => setStandalone(!isFramed()), []);

  const showClose = session.mode === 'modal' && !standalone;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="sticky top-0 z-40 flex items-center gap-3 border-b border-slate-200 bg-white/95 px-3 py-2 backdrop-blur">
        {backHref ? (
          <Link
            href={backHref}
            className="-ml-1 flex min-h-[40px] items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-color)]"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="15 18 9 12 15 6" />
            </svg>
            {backLabel}
          </Link>
        ) : (
          <span className="truncate px-1 text-sm font-semibold text-slate-900">{brandName}</span>
        )}

        <span className="ml-auto truncate text-xs font-semibold uppercase tracking-wide text-slate-400">
          {STEP_TITLES[step]}
        </span>

        {showClose && (
          <button
            type="button"
            onClick={() => postToHost('close', { reason: 'button' })}
            aria-label="Close booking"
            className="-mr-1 flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-color)]"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {children}
    </div>
  );
}

export default EmbedShell;
