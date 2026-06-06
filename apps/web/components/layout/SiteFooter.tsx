/**
 * White-label site footer for the customer booking portal.
 *
 * Shows the OPERATOR's brand and a dynamic copyright — no platform branding,
 * no "Powered by" line (a deliberate differentiator vs. the legacy incumbent).
 * Brand data comes from getBrand(); the brand color is set locally so the
 * footer is self-contained.
 */
import Link from 'next/link';
import { getBrand, brandStyle } from '@/lib/brand';

interface FooterLink {
  label: string;
  href: string;
}

const LINKS: FooterLink[] = [
  { label: 'Book', href: '/' },
  { label: 'My Booking', href: '/lookup' },
  { label: 'Terms', href: '/terms' },
  { label: 'Privacy', href: '/privacy' },
];

export async function SiteFooter() {
  const brand = await getBrand();
  const year = new Date().getFullYear();

  return (
    <footer
      style={brandStyle(brand)}
      className="mt-auto border-t border-slate-200 bg-white"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-6 w-6 rounded-md"
            style={{ backgroundColor: 'var(--brand-color)' }}
          />
          <span className="text-sm font-semibold text-slate-900">{brand.name}</span>
        </div>

        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-slate-500 transition-colors hover:text-slate-900"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="border-t border-slate-100">
        <div className="mx-auto max-w-6xl px-4 py-4">
          <p className="text-xs text-slate-400">
            &copy; {year} {brand.name}. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}

export default SiteFooter;
