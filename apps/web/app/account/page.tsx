import type { Metadata } from 'next';
import Link from 'next/link';
import { getBrand, brandStyle } from '@/lib/brand';
import { getCustomerSession } from '@/lib/session';
import SiteHeader from '@/components/layout/SiteHeader';
import SiteFooter from '@/components/layout/SiteFooter';
import { LookupForm } from './lookup-form';
import { signOut } from './actions';

export const metadata: Metadata = {
  title: 'My Bookings',
  description: 'Look up, manage, and review your reservations.',
};

// Reads the session cookie → render per request.
export const dynamic = 'force-dynamic';

/**
 * Customer account landing.
 *
 * Signed-in customers (email-OTP, D-017) see who they are + a sign-out, and the
 * lookup form is prefilled with their email. Signed-out customers can sign in
 * (passwordless) or fall back to the order-number + email lookup. Fully
 * white-label — operator brand only, never platform branding.
 */
export default async function AccountPage() {
  const brand = await getBrand();
  const session = getCustomerSession();

  return (
    <div style={brandStyle(brand)} className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-10">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">My Bookings</h1>
          <p className="mt-2 text-sm text-slate-600">
            {session
              ? 'Enter your confirmation number to open a reservation.'
              : 'Sign in, or enter your confirmation number and email to manage a reservation.'}
          </p>
        </header>

        {session ? (
          <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
            <span className="text-slate-600">
              Signed in as <span className="font-medium text-slate-900">{session.email}</span>
            </span>
            <form action={signOut}>
              <button
                type="submit"
                className="font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
              >
                Sign out
              </button>
            </form>
          </div>
        ) : (
          <div className="mb-6 rounded-2xl border border-brand/30 bg-brand/5 p-5 text-center">
            <p className="text-sm font-medium text-slate-700">
              The fastest way in — no confirmation number needed.
            </p>
            <Link
              href="/login?next=/account"
              className="mt-3 inline-block rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
            >
              Sign in with email
            </Link>
          </div>
        )}

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          {!session && (
            <div className="mb-4 flex items-center gap-3">
              <span className="h-px flex-1 bg-slate-200" />
              <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                or look up a booking
              </span>
              <span className="h-px flex-1 bg-slate-200" />
            </div>
          )}
          <LookupForm defaultEmail={session?.email} />
        </section>

        <p className="mt-6 text-center text-sm text-slate-500">
          Want to book something new?{' '}
          <Link href="/" className="font-medium text-brand hover:underline">
            Browse activities
          </Link>
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
