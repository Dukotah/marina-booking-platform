import type { Metadata } from 'next';
import { getBrand, brandStyle } from '@/lib/brand';
import SiteHeader from '@/components/layout/SiteHeader';
import SiteFooter from '@/components/layout/SiteFooter';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'How your information is collected and used when you book.',
};

/**
 * Privacy Policy — white-label privacy notice for the operator. Plain-language
 * placeholder describing the data a booking actually collects; swap in the
 * operator's reviewed policy before go-live.
 */
export default function PrivacyPage() {
  const brand = getBrand();
  const year = new Date().getFullYear();

  return (
    <div style={brandStyle(brand)} className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-12">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Privacy Policy</h1>
        <p className="mt-2 text-sm text-slate-500">Last updated {year}</p>

        <div className="mt-8 space-y-6 text-sm leading-relaxed text-slate-600">
          <section>
            <h2 className="text-base font-semibold text-slate-900">What we collect</h2>
            <p className="mt-2">
              To take and manage your booking, {brand.name} collects your name, email,
              phone number, the activity and time you reserve, and any participant details
              (such as a waiver or date of birth) required for the activity. Card payments
              are processed by our payment provider; {brand.name} does not store full card
              numbers.
            </p>
          </section>
          <section>
            <h2 className="text-base font-semibold text-slate-900">How we use it</h2>
            <p className="mt-2">
              Your information is used to confirm and manage your reservation, send booking
              and reminder notifications, process payments and refunds, and comply with
              safety and legal requirements. We do not sell your personal information.
            </p>
          </section>
          <section>
            <h2 className="text-base font-semibold text-slate-900">Your booking data</h2>
            <p className="mt-2">
              You can look up your reservation from the{' '}
              <a
                href="/account"
                className="font-medium underline-offset-2 hover:underline"
                style={{ color: 'var(--brand-color)' }}
              >
                My Booking
              </a>{' '}
              page at any time. To request a copy or deletion of your data, contact{' '}
              {brand.name}.
            </p>
          </section>
          <section>
            <h2 className="text-base font-semibold text-slate-900">Contact</h2>
            <p className="mt-2">
              Questions about your privacy? Reach out to {brand.name} and we&apos;ll
              respond promptly.
            </p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
