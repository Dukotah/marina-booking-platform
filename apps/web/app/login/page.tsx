import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getBrand, brandStyle } from '@/lib/brand';
import { getCustomerSession } from '@/lib/session';
import SiteHeader from '@/components/layout/SiteHeader';
import SiteFooter from '@/components/layout/SiteFooter';
import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to view and manage your reservations.',
};

// Reads the session cookie → must render per request.
export const dynamic = 'force-dynamic';

function safeNext(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  return v.startsWith('/') && !v.startsWith('//') ? v : '/account';
}

/**
 * Passwordless customer sign-in (email-OTP, D-017). Already-signed-in customers
 * are sent straight to their destination. White-label throughout.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  const next = safeNext(searchParams.next);

  // Already signed in → skip the form.
  if (getCustomerSession()) {
    redirect(next);
  }

  const brand = await getBrand();

  return (
    <div style={brandStyle(brand)} className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-10">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Sign in</h1>
          <p className="mt-2 text-sm text-slate-600">
            View and manage your reservations with {brand.name}.
          </p>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <LoginForm next={next} />
        </section>

        <p className="mt-6 text-center text-sm text-slate-500">
          Have a confirmation number instead?{' '}
          <Link href="/account" className="font-medium text-brand hover:underline">
            Look up a booking
          </Link>
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
