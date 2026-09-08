/**
 * Catalog hero for the customer booking portal home page — "Estate" styling.
 *
 * Quietly premium: the operator's name in Marcellus over the warm cream page,
 * one soft-spoken line beneath. No colored band, no gradient, no icon rows —
 * per DESIGN.md the water lives in the photographs, not the chrome. Fully
 * white-label: all copy comes from the resolved operator brand. Server
 * component (no interactivity).
 */
import { getBrandAsync, type Brand } from '@/lib/brand';

interface CatalogHeroProps {
  /**
   * Number of bookable activities. Kept for API compatibility with the page;
   * no longer rendered — the departures board directly below IS the
   * availability signal, and a counter line above it was noise.
   */
  activityCount: number;
  /**
   * Resolved operator brand. Passed by the page (which already fetched it) so the
   * hero headline is the operator's name without a second round-trip; falls back
   * to a fresh fetch if a caller omits it.
   */
  brand?: Brand;
}

export async function CatalogHero({ brand: brandProp }: CatalogHeroProps) {
  const brand = brandProp ?? (await getBrandAsync());

  return (
    <section className="bg-bg">
      <div className="mx-auto max-w-[1120px] px-6 pb-6 pt-10 sm:pb-8 sm:pt-16">
        <h1 className="max-w-3xl font-display text-[28px] leading-[1.15] tracking-[0.02em] text-ink sm:text-4xl">
          {brand.name}
        </h1>
        <p className="mt-3 max-w-xl text-base leading-[1.55] text-muted">
          {brand.tagline ??
            'Reserve your day on the water — live availability, all-in prices, no account needed.'}
        </p>
      </div>
    </section>
  );
}

export default CatalogHero;
