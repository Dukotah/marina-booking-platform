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

interface NavItem {
  label: string;
  href: string;
}

const NAV: NavItem[] = [
  { label: 'Book', href: '/' },
  { label: 'My Bookings', href: '/account' },
  { label: 'Sign in', href: '/login' },
];

function BrandMark({ brand }: { brand: Brand }) {
  if (brand.logoLightUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- tenant logo from arbitrary origin
      <img
        src={brand.logoLightUrl}
        alt={brand.name}
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

  return (
    <header
      style={brandStyle(brand)}
      className="sticky top-0 z-40 w-full border-b border-slate-200 bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/75"
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" aria-label={`${brand.name} home`} className="shrink-0">
          <BrandMark brand={brand} />
        </Link>

        {/* Desktop nav */}
        <nav aria-label="Primary" className="hidden items-center gap-6 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-sm font-medium text-slate-600 transition-colors hover:text-slate-900"
            >
              {item.label}
            </Link>
          ))}
          <Link
            href="/"
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
            style={{ backgroundColor: 'var(--brand-color)' }}
          >
            Book now
          </Link>
        </nav>

        {/* Mobile nav — CSS-only disclosure (no JS). */}
        <details className="relative md:hidden">
          <summary
            className="flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-lg border border-slate-200 text-slate-700 [&::-webkit-details-marker]:hidden"
            aria-label="Open menu"
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
              className="mx-2 mt-1 block rounded-lg px-3 py-2 text-center text-sm font-semibold text-white"
              style={{ backgroundColor: 'var(--brand-color)' }}
            >
              Book now
            </Link>
          </nav>
        </details>
      </div>
    </header>
  );
}

export default SiteHeader;
