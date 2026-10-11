import type { Metadata } from 'next';
import { getBrandAsync, brandStyle } from '@/lib/brand';
import SiteHeader from '@/components/layout/SiteHeader';
import SiteFooter from '@/components/layout/SiteFooter';
import GiftCardForm from '@/components/gift/GiftCardForm';

export const metadata: Metadata = {
  title: 'Gift Cards',
  description: 'Buy a gift card and send it straight to someone you love.',
};

// The purchase hits the live API (charge + issue + email); nothing here may be
// cached across requests.
export const dynamic = 'force-dynamic';

/**
 * Public gift-card storefront. Pick an amount, name a recipient, and buy — the
 * card is charged, issued, and the code emailed to the recipient in one step.
 *
 * White-label (operator brand) and warm Estate theming throughout. The money
 * discipline — amount shown == amount charged == card value — is enforced on the
 * server (the API re-derives the amount from its allowed set); this page only
 * presents the choices.
 */
export default async function GiftPage() {
  const brand = await getBrandAsync();

  return (
    <div style={brandStyle(brand)} className="flex min-h-screen flex-col bg-[var(--bg)]">
      <SiteHeader />

      <main id="main-content" tabIndex={-1} className="flex-1">
        <div className="border-b border-[var(--hairline)]">
          <div className="mx-auto max-w-3xl px-4 py-10 sm:py-12">
            <h1 className="text-3xl font-bold tracking-tight text-[var(--ink)]">Gift cards</h1>
            <p className="mt-2 max-w-2xl text-base text-[var(--muted)]">
              Give a day on the water. Pick an amount, write a note, and we&apos;ll email the
              code straight to your recipient &mdash; ready to spend on any booking with{' '}
              {brand.name}.
            </p>
          </div>
        </div>

        <div className="mx-auto max-w-xl px-4 py-10">
          <GiftCardForm />
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
