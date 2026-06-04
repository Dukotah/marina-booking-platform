/**
 * Catalog hero for the customer booking portal home page.
 *
 * Fully white-label: the headline uses the resolved operator brand name and an
 * optional tagline — never platform or hardcoded marina branding. The brand
 * color drives a soft gradient backdrop and the accent rule. Server component
 * (no interactivity).
 */
import { getBrand } from '@/lib/brand';
import { readableTextOn } from './color';

interface CatalogHeroProps {
  /** Number of bookable activities, shown as a confidence signal when > 0. */
  activityCount: number;
}

export function CatalogHero({ activityCount }: CatalogHeroProps) {
  const brand = getBrand();
  const onBrand = readableTextOn(brand.color);

  return (
    <section
      className="relative overflow-hidden"
      style={{
        background: `linear-gradient(135deg, ${brand.color} 0%, ${brand.color} 55%, color-mix(in srgb, ${brand.color} 70%, #0f172a) 100%)`,
      }}
    >
      {/* Decorative wave glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          backgroundImage:
            'radial-gradient(closest-side at 80% 0%, rgba(255,255,255,0.5), transparent 70%)',
        }}
      />

      <div className="relative mx-auto max-w-6xl px-4 py-16 sm:py-20" style={{ color: onBrand }}>
        {brand.tagline && (
          <p className="mb-3 inline-flex items-center rounded-full bg-white/15 px-3 py-1 text-sm font-medium backdrop-blur">
            {brand.tagline}
          </p>
        )}
        <h1 className="max-w-2xl text-3xl font-extrabold leading-tight tracking-tight sm:text-5xl">
          {brand.name}
        </h1>
        <p className="mt-4 max-w-xl text-base/relaxed opacity-90 sm:text-lg">
          Reserve your spot in minutes. Real-time availability, instant
          confirmation, no account required.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm font-medium opacity-90">
          {activityCount > 0 && (
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="text-lg">{'\u{2693}'}</span>
              {activityCount} {activityCount === 1 ? 'experience' : 'experiences'} to book
            </span>
          )}
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="text-lg">{'\u{1F4F1}'}</span>
            Book from any device
          </span>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="text-lg">{'\u{2705}'}</span>
            Instant confirmation
          </span>
        </div>
      </div>
    </section>
  );
}

export default CatalogHero;
