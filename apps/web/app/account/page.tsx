import type { Metadata } from 'next';
import Link from 'next/link';
import { getBrand, brandStyle } from '@/lib/brand';
import SiteHeader from '@/components/layout/SiteHeader';
import SiteFooter from '@/components/layout/SiteFooter';
import { LookupForm } from './lookup-form';

export const metadata: Metadata = {
  title: 'My Bookings',
  description: 'Look up, manage, and review your reservations.',
};

/**
 * Customer account landing — booking lookup.
 *
 * Sign-in is email OTP: the customer enters their confirmation (order) number +
 * the email used to book, receives a one-time code, and we set a secure httpOnly
 * session cookie (see actions.ts / apps/api auth route). Fully white-label — the
 * operator name/brand come from tenant brand data, never platform/marina branding.
 */
export default function AccountPage() {
  const brand = getBrand();

  return (
    <div style={brandStyle(brand)} className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-10">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">My Bookings</h1>
          <p className="mt-2 text-sm text-slate-600">
            Enter your confirmation number and email and we'll send a one-time code to
            view or manage your reservation.
          </p>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <LookupForm />
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
