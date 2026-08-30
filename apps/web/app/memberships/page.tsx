import type { Metadata } from 'next';
import Link from 'next/link';
import { getBrand, brandStyle } from '@/lib/brand';
import SiteHeader from '@/components/layout/SiteHeader';
import SiteFooter from '@/components/layout/SiteFooter';
import { getStripeConfig } from '@/app/checkout/stripe-config';
import {
  getMembershipOffers,
  getMyHoldings,
} from '@/components/memberships/data';
import { HoldingList, SignInPrompt } from '@/components/memberships/HoldingList';
import { MembershipOffers } from '@/components/memberships/MembershipOffers';

export const metadata: Metadata = {
  title: 'Passes & Memberships',
  description: 'Season passes, punch cards, and member pricing.',
};

// Holdings are per-customer and the catalog changes when the operator edits it;
// neither may be cached across requests.
export const dynamic = 'force-dynamic';

/**
 * Customer-facing memberships page: what is on offer, what you already hold, and
 * the flow that buys one.
 *
 * White-label throughout — the operator's brand, never the platform's. The card
 * field and the tokenize handle are the checkout's own `PaymentSection`, so a
 * membership is paid for through exactly the payment driver a booking is (Stripe in
 * cloud mode, the sandbox simulator with its real declines and 3DS challenges
 * locally).
 *
 * A page that renders in three states, all of them deliberate: the API unreachable,
 * the operator selling nothing, and the ordinary case. None of them is a crash.
 */
export default async function MembershipsPage() {
  const brand = getBrand();
  const stripe = getStripeConfig();

  const [{ offers, failed }, { signedIn, holdings }] = await Promise.all([
    getMembershipOffers(),
    getMyHoldings(),
  ]);

  return (
    <div style={brandStyle(brand)} className="flex min-h-screen flex-col">
      <SiteHeader />

      <main id="main-content" tabIndex={-1} className="flex-1">
        <div className="border-b border-slate-200 bg-slate-50">
          <div className="mx-auto max-w-6xl px-4 py-10 sm:py-12">
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">
              Passes &amp; memberships
            </h1>
            <p className="mt-2 max-w-2xl text-base text-slate-700">
              Buy once, then pay the member price every time you book with {brand.name}. Your
              discount is applied automatically at checkout — there is no code to remember.
            </p>
          </div>
        </div>

        <div className="mx-auto max-w-6xl px-4 py-10">
          <section aria-labelledby="your-passes">
            <h2 id="your-passes" className="text-xl font-bold text-slate-900">
              Your passes
            </h2>
            <div className="mt-4">
              {signedIn ? <HoldingList holdings={holdings} /> : <SignInPrompt />}
            </div>
          </section>

          <section aria-labelledby="on-offer" className="mt-12">
            <h2 id="on-offer" className="text-xl font-bold text-slate-900">
              On offer
            </h2>

            {failed ? (
              <p
                role="status"
                className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900"
              >
                We could not load memberships just now. Please refresh in a moment, or{' '}
                <Link href="/" className="font-medium underline">
                  browse activities
                </Link>{' '}
                in the meantime.
              </p>
            ) : offers.length === 0 ? (
              <p className="mt-4 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-700">
                {brand.name} is not selling passes online right now. Get in touch if you would
                like one.
              </p>
            ) : (
              <div className="mt-4">
                <MembershipOffers offers={offers} stripe={stripe} />
              </div>
            )}
          </section>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
