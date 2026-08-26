/**
 * Friendly failure/empty state for the embedded widget.
 *
 * The widget lives on the operator's own homepage, so a broken booking box is a
 * broken storefront. Every failure path lands here instead: a plain explanation,
 * and where possible a way forward that stays inside the frame.
 */

import Link from 'next/link';

interface EmbedNoticeProps {
  title: string;
  body: string;
  actionHref?: string | null;
  actionLabel?: string;
}

export function EmbedNotice({ title, body, actionHref, actionLabel }: EmbedNoticeProps) {
  return (
    <div className="flex flex-col items-center px-5 py-12 text-center">
      <div
        className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400"
        aria-hidden
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>
      <h1 className="text-base font-semibold text-slate-900">{title}</h1>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-slate-600">{body}</p>
      {actionHref && (
        <Link
          href={actionHref}
          className="mt-5 flex min-h-[44px] items-center justify-center rounded-lg px-5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
          style={{ backgroundColor: 'var(--brand-color)' }}
        >
          {actionLabel ?? 'Try again'}
        </Link>
      )}
    </div>
  );
}

export default EmbedNotice;
