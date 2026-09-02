import type { Metadata } from 'next';
import { getBrandAsync, brandStyle } from '@/lib/brand';
import SiteHeader from '@/components/layout/SiteHeader';
import SiteFooter from '@/components/layout/SiteFooter';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The terms that govern bookings and use of this site.',
};

/**
 * Terms of Service — white-label booking terms for the operator. Content is
 * intentionally plain and operator-agnostic; the operator name comes from tenant
 * brand data. Swap in the operator's reviewed legal copy before go-live.
 */
export default async function TermsPage() {
  const brand = await getBrandAsync();
  const year = new Date().getFullYear();

  return (
    <div style={brandStyle(brand)} className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-2xl flex-1 px-4 py-12">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Terms of Service</h1>
        <p className="mt-2 text-sm text-slate-500">Last updated {year}</p>

        <div className="mt-8 space-y-6 text-sm leading-relaxed text-slate-600">
          <section>
            <h2 className="text-base font-semibold text-slate-900">Bookings</h2>
            <p className="mt-2">
              When you book an activity with {brand.name}, you agree to arrive at the
              scheduled time and to follow all safety instructions given by staff. A
              signed waiver may be required before participation. Reservations are for the
              activity, date, time, and party size shown at checkout.
            </p>
          </section>
          <section>
            <h2 className="text-base font-semibold text-slate-900">Payments &amp; fees</h2>
            <p className="mt-2">
              Prices are shown at checkout in U.S. dollars and include any applicable
              taxes and processing fees before you confirm. Payment is due at the time of
              booking unless otherwise stated.
            </p>
          </section>
          <section>
            <h2 className="text-base font-semibold text-slate-900">Changes &amp; cancellations</h2>
            <p className="mt-2">
              You can look up and manage your reservation at any time from the{' '}
              <a
                href="/account"
                className="font-medium underline-offset-2 hover:underline"
                style={{ color: 'var(--brand-color)' }}
              >
                My Booking
              </a>{' '}
              page using your confirmation number and email. Rescheduling and cancellation
              windows are shown on your booking; refunds follow the policy in effect at
              the time of purchase.
            </p>
          </section>
          <section>
            <h2 className="text-base font-semibold text-slate-900">Safety &amp; liability</h2>
            <p className="mt-2">
              Activities on or near the water carry inherent risks. You participate at
              your own risk and agree to follow all posted rules and staff direction.
              {' '}{brand.name} is not liable for personal items or for injury resulting
              from failure to follow safety instructions.
            </p>
          </section>
          <section>
            <h2 className="text-base font-semibold text-slate-900">Contact</h2>
            <p className="mt-2">
              Questions about these terms? Reach out to {brand.name} and we&apos;ll be
              glad to help.
            </p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
