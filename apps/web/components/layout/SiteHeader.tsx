/**
 * White-label site header for the customer booking portal.
 *
 * Renders the OPERATOR's brand only (logo or name + tagline) — never any
 * platform branding. Brand data comes from getBrand(); the brand color drives
 * the logo accent and CTA via the `--brand-color` variable, which this header
 * also sets locally so it works even if a parent layout hasn't set it.
 *
 * Server component (no client interactivity needed): the mobile experience uses
 * a CSS-only collapse so it stays fast and avoids hydration cost.
 */
import Link from 'next/link';
import { getBrand, brandStyle, type Brand } from '@/lib/brand';
import { DEMO_MODE } from '@/lib/demo/config';

/** sRGB channel (0–255) to its linear-light value, per WCAG 2.x. */
function channelLuminance(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a #rgb / #rrggbb color, or null if unparseable. */
function relativeLuminance(hex: string): number | null {
  const v = hex.trim().replace(/^#/, '');
  const full =
    v.length === 3 && /^[0-9a-fA-F]{3}$/.test(v)
      ? v[0] + v[0] + v[1] + v[1] + v[2] + v[2]
      : v.length === 6 && /^[0-9a-fA-F]{6}$/.test(v)
        ? v
        : null;
  if (!full) return null;
  const r = channelLuminance(parseInt(full.slice(0, 2), 16));
  const g = channelLuminance(parseInt(full.slice(2, 4), 16));
  const b = channelLuminance(parseInt(full.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: number, b: number): number {
  return a >= b ? (a + 0.05) / (b + 0.05) : (b + 0.05) / (a + 0.05);
}

/**
 * Pick a label color that clears WCAG 1.4.3 (4.5:1) on the tenant's brand color.
 *
 * The brand color is operator-supplied, so hardcoding white text on it is a real
 * contrast bug rather than a theoretical one: the default sky `#0ea5e9` gives
 * only 2.8:1 against white. Trying white, then near-black, then pure black is
 * provably safe — for any background, the better of white and black is at least
 * 4.58:1 — so no per-tenant override is ever needed.
 */
function onBrandForeground(brandColor: string): string {
  const bg = relativeLuminance(brandColor);
  if (bg === null) return '#ffffff';
  for (const candidate of ['#ffffff', '#0f172a', '#000000']) {
    const fg = relativeLuminance(candidate);
    if (fg !== null && contrastRatio(bg, fg) >= 4.5) return candidate;
  }
  return '#000000';
}

/**
 * Focus ring for controls painted in the brand color. The global
 * `:focus-visible` outline is itself `--brand-color`, which all but disappears
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

export function SiteHeader() {
  const brand = getBrand();
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
