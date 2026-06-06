import Link from 'next/link';
import { getBrand, brandStyle } from '@/lib/brand';

/**
 * Graceful 404 for an activity that doesn't exist (or isn't bookable online for
 * the resolved tenant). White-label only — routes the customer back to the
 * catalog rather than showing a dead end.
 */
export default async function ActivityNotFound() {
  const brand = await getBrand();
  return (
    <main
      style={brandStyle(brand)}
      className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center"
    >
      <span
        aria-hidden
        className="flex h-14 w-14 items-center justify-center rounded-2xl text-white"
        style={{ backgroundColor: 'var(--brand-color)' }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </span>
      <h1 className="mt-5 text-2xl font-bold tracking-tight text-slate-900">
        We couldn&apos;t find that activity
      </h1>
      <p className="mt-2 text-slate-600">
        It may no longer be available. Browse everything we offer and pick another
        adventure.
      </p>
      <Link
        href="/"
        className="mt-6 rounded-xl px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
        style={{ backgroundColor: 'var(--brand-color)' }}
      >
        Back to booking
      </Link>
    </main>
  );
}
