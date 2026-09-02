/**
 * White-label site header for the customer booking portal.
 *
 * Renders the OPERATOR's brand only (logo or name + tagline) — never any
 * platform branding. Brand data comes from getBrandAsync() (the operator record,
 * env/base fallback); the brand color drives
 * the logo accent and CTA via the `--brand-color` variable, which this header
 * also sets locally so it works even if a parent layout hasn't set it. The CTA
 * label color comes from lib/brand's onBrandForeground() rather than a
 * hardcoded white, because the brand is operator-chosen (see that file).
 *
 * Server component (no client interactivity needed): the mobile experience uses
 * a CSS-only collapse so it stays fast and avoids hydration cost.
 */
import Link from 'next/link';
import { getBrandAsync, brandStyle, onBrandForeground, type Brand } from '@/lib/brand';
import { DEMO_MODE } from '@/lib/demo/config';

/**
 * Focus ring for controls painted in the brand color. The global
 * `:focus-visible` outline is a brand-derived color, which all but disappears
 * on a brand-filled button, so brand CTAs opt out and ring in slate-900.
 */
const BRAND_CTA_FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2';

/** Slim notice shown only in DEMO_MODE so viewers know payments are simulated. */
function DemoBanner() {
  if (!DEMO_MODE) return null;
  return (
    // A landmark so the notice is reachable from a screen reader's landmark
    // list and is not orphaned content sitting outside every region.
    <aside
      aria-label="Demo mode notice"
      className="w-full bg-slate-900 px-4 py-1.5 text-center text-xs font-medium text-slate-100"
    >
      Interactive demo — bookings are simulated, no real payments are taken. Try
      promo code <span className="font-semibold text-white">SONOMA10</span> at checkout.
    </aside>
  );
}

interface NavItem {
  label: string;
  href: string;
}

const NAV: NavItem[] = [
  { label: 'Book', href: '/' },
  { label: 'My Booking', href: '/account' },
];

function BrandMark({ brand }: { brand: Brand }) {
  if (brand.logoLightUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- tenant logo from arbitrary origin
      <img
        src={brand.logoLightUrl}
        // The wrapping link is labelled "<brand> home"; an alt here would make
        // the accessible name read the operator name twice.
        alt=""
        className="h-8 w-auto max-w-[200px] object-contain"
      />
    );
  }
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden
        className="inline-block h-7 w-7 rounded-lg"
        style={{ backgroundColor: 'var(--brand-color)' }}
      />
      <span className="flex flex-col leading-tight">
        <span className="text-lg font-bold tracking-tight text-slate-900">{brand.name}</span>
        {brand.tagline && (
          <span className="text-xs font-medium text-slate-500">{brand.tagline}</span>
        )}
      </span>
    </span>
  );
}

export async function SiteHeader() {
  const brand = await getBrandAsync();
  const ctaForeground = onBrandForeground(brand.color);

  return (
    <>
      {/*
        WCAG 2.4.1. Visually hidden until focused, and first in the tab order so
        a keyboard user lands on it before the nav. Targets `#main-content`,
        which each page puts on its <main>.
      */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-slate-900 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to main content
      </a>
      <DemoBanner />
      <header
        style={brandStyle(brand)}
        className="sticky top-0 z-40 w-full border-b border-slate-200 bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/75"
      >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" aria-label={`${brand.name} home`} className="shrink-0 rounded-lg">
          <BrandMark brand={brand} />
        </Link>

        {/* Desktop nav */}
        <nav aria-label="Primary" className="hidden items-center gap-6 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded text-sm font-medium text-slate-600 transition-colors hover:text-slate-900"
            >
              {item.label}
            </Link>
          ))}
          <Link
            href="/"
            className={`rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition hover:opacity-90 ${BRAND_CTA_FOCUS}`}
            style={{ backgroundColor: 'var(--brand-color)', color: ctaForeground }}
          >
            Book now
          </Link>
        </nav>

        {/* Mobile nav — CSS-only disclosure (no JS). <summary> already exposes
            its expanded/collapsed state to assistive tech, so no aria-expanded. */}
        <details className="relative md:hidden">
          <summary
            className="flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-lg border border-slate-200 text-slate-700 [&::-webkit-details-marker]:hidden"
            aria-label="Menu"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <line x1="4" y1="6" x2="20" y2="6" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="18" x2="20" y2="18" />
            </svg>
          </summary>
          <nav
            aria-label="Mobile"
            className="absolute right-0 mt-2 w-48 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
          >
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="block px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                {item.label}
              </Link>
            ))}
            <Link
              href="/"
              className={`mx-2 mt-1 block rounded-lg px-3 py-2 text-center text-sm font-semibold ${BRAND_CTA_FOCUS}`}
              style={{ backgroundColor: 'var(--brand-color)', color: ctaForeground }}
            >
              Book now
            </Link>
          </nav>
        </details>
      </div>
      </header>
    </>
  );
}

export default SiteHeader;
