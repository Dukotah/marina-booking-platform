/**
 * White-label site header for the customer booking portal — "Estate" chrome.
 *
 * A calm masthead: the operator's name set in Marcellus over the warm cream
 * page, a single hairline underneath, quiet Figtree navigation. No colored
 * band, no blur, no shadow — typography and air do the work (DESIGN.md).
 *
 * Brand data still comes from getBrandAsync() (operator record, env/base
 * fallback) and the header still publishes the `--brand-*` variables for
 * descendants, but per the 2026-09-07 Estate decision the operator BRAND COLOR
 * NO LONGER PAINTS ANY CHROME — no header band, no CTA fill, no logo swatch.
 * It is reserved for the favicon/logo area; a configured logo image is shown
 * as-is. Multi-tenant theming can re-enter later via the Estate tokens.
 *
 * Server component (no client interactivity needed): the mobile experience uses
 * a CSS-only collapse so it stays fast and avoids hydration cost.
 */
import Link from 'next/link';
import { getBrandAsync, brandStyle, type Brand } from '@/lib/brand';
import { DEMO_MODE } from '@/lib/demo/config';

/** Slim notice shown only in DEMO_MODE so viewers know payments are simulated. */
function DemoBanner() {
  if (!DEMO_MODE) return null;
  return (
    // A landmark so the notice is reachable from a screen reader's landmark
    // list and is not orphaned content sitting outside every region.
    <aside
      aria-label="Demo mode notice"
      className="w-full bg-ink px-4 py-1.5 text-center text-[13px] font-medium text-bg"
    >
      Interactive demo — bookings are simulated, no real payments are taken. Try
      promo code <span className="font-semibold">SONOMA10</span> at checkout.
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
  // Estate wordmark: Marcellus, gently letterspaced — the brand IS the type.
  return (
    <span className="font-display text-[19px] leading-tight tracking-[0.04em] text-ink">
      {brand.name}
    </span>
  );
}

export async function SiteHeader() {
  const brand = await getBrandAsync();

  return (
    <>
      {/*
        WCAG 2.4.1. Visually hidden until focused, and first in the tab order so
        a keyboard user lands on it before the nav. Targets `#main-content`,
        which each page puts on its <main>.
      */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-bg"
      >
        Skip to main content
      </a>
      <DemoBanner />
      <header
        style={brandStyle(brand)}
        className="sticky top-0 z-40 w-full border-b border-hairline bg-bg"
      >
        <div className="mx-auto flex h-16 max-w-[1120px] items-center justify-between gap-4 px-6">
          <Link href="/" aria-label={`${brand.name} home`} className="shrink-0 rounded-lg">
            <BrandMark brand={brand} />
          </Link>

          {/* Desktop nav — quiet Figtree links; the header carries no colored CTA
              because the ONE sage action per view belongs to the content (Reserve). */}
          <nav aria-label="Primary" className="hidden items-center gap-8 md:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded text-sm font-medium text-muted transition-colors hover:text-ink"
              >
                {item.label}
              </Link>
            ))}
            {brand.phone && (
              <a
                href={`tel:${brand.phone.replace(/[^\d+]/g, '')}`}
                className="rounded-lg border border-hairline px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface"
              >
                <span className="tnum">{brand.phone}</span>
              </a>
            )}
          </nav>

          {/* Mobile nav — CSS-only disclosure (no JS). <summary> already exposes
              its expanded/collapsed state to assistive tech, so no aria-expanded. */}
          <details className="relative md:hidden">
            <summary
              className="flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-lg border border-hairline text-ink [&::-webkit-details-marker]:hidden"
              aria-label="Menu"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
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
              className="absolute right-0 mt-2 w-48 overflow-hidden rounded-sheet border border-hairline bg-surface py-1 shadow-overlay"
            >
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="block px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-bg"
                >
                  {item.label}
                </Link>
              ))}
              {brand.phone && (
                <a
                  href={`tel:${brand.phone.replace(/[^\d+]/g, '')}`}
                  className="block border-t border-hairline px-4 py-2.5 text-sm font-medium text-muted"
                >
                  Call <span className="tnum">{brand.phone}</span>
                </a>
              )}
            </nav>
          </details>
        </div>
      </header>
    </>
  );
}

export default SiteHeader;
