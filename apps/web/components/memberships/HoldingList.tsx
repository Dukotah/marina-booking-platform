import Link from 'next/link';
import { CalendarClock, Ticket } from 'lucide-react';
import { formatDate } from '@/lib/format';
import type { MembershipHolding } from './types';

/**
 * What the signed-in customer already holds.
 *
 * Render-only (no 'use client'): it ships no JavaScript, which is the right trade
 * for a rural-cellular portal where every kilobyte is a second.
 *
 * The status shown is the API's `statusLabel`, not the raw enum — a season pass
 * whose window has closed still stores as ACTIVE until a booking touches it, and
 * telling a customer their expired pass is "Active" is worse than saying nothing.
 */
export function HoldingList({ holdings }: { holdings: MembershipHolding[] }) {
  if (holdings.length === 0) {
    return (
      <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-700">
        You do not hold any passes yet. Anything you buy below shows up here.
      </p>
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {holdings.map((h) => (
        <li key={h.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-slate-900">{h.membershipName}</h3>
              <p className="mt-0.5 text-sm text-slate-700">{h.benefit}</p>
            </div>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                h.usable ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'
              }`}
            >
              {h.statusLabel}
            </span>
          </div>

          <dl className="mt-3 space-y-1.5 text-sm text-slate-700">
            {h.remainingUses != null ? (
              <div className="flex items-center gap-2">
                <Ticket className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
                <dt className="sr-only">Launches remaining</dt>
                <dd>
                  {h.remainingUses} {h.remainingUses === 1 ? 'launch' : 'launches'} left
                </dd>
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
              <dt className="sr-only">Valid until</dt>
              <dd>{h.expiresAt ? `Valid until ${formatDate(h.expiresAt)}` : 'Never expires'}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

/** The signed-out prompt. Points at the existing magic-link sign-in, not a new one. */
export function SignInPrompt() {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <p className="text-sm text-slate-700">
        Sign in to see the passes you already hold.
      </p>
      <Link
        href="/account"
        className="mt-3 inline-block rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
      >
        Sign in
      </Link>
    </div>
  );
}
