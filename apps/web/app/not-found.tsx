import Link from 'next/link';
import { getBrand, brandStyle } from '@/lib/brand';

/**
 * App-root 404 for the customer portal (any unmatched path that isn't covered by
 * a more specific segment not-found). White-label — routes the visitor back to
 * the booking home rather than a dead end.
 */
export default function NotFound() {
  const brand = getBrand();
  return (
    <main
      style={brandStyle(brand)}
      className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-4 py-16 text-center"
    >
      <span
        aria-hidden
        className="flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-sm"
        style={{ backgroundColor: 'var(--brand-color)' }}
      >
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </span>
      <h1 className="mt-5 text-2xl font-bold tracking-tight text-slate-900">
        Page not found
      </h1>
      <p className="mt-2 text-slate-600">
        The page you&apos;re looking for doesn&apos;t exist or has moved. Let&apos;s get
        you back to booking.
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
