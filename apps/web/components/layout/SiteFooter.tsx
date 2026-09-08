/**
 * White-label site footer for the customer booking portal — "Estate" chrome.
 *
 * Shows the OPERATOR's brand and a dynamic copyright — no platform branding,
 * no "Powered by" line (a deliberate differentiator vs. the legacy incumbent).
 * Brand data comes from getBrandAsync() (the operator record, env/base
 * fallback). Per the Estate decision the brand COLOR paints no chrome here:
 * the wordmark is Marcellus ink on cream over a single hairline.
 */
import Link from 'next/link';
import { getBrandAsync, brandStyle } from '@/lib/brand';

interface FooterLink {
  label: string;
  href: string;
}

const LINKS: FooterLink[] = [
  { label: 'Book', href: '/' },
  { label: 'My Booking', href: '/account' },
  { label: 'Terms', href: '/terms' },
  { label: 'Privacy', href: '/privacy' },
];

export async function SiteFooter() {
  const brand = await getBrandAsync();
  const year = new Date().getFullYear();

  return (
    <footer style={brandStyle(brand)} className="mt-auto border-t border-hairline bg-bg">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-6 px-6 py-12 sm:flex-row sm:items-center sm:justify-between">
        <span className="font-display text-base tracking-[0.04em] text-ink">{brand.name}</span>

        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded text-sm text-muted transition-colors hover:text-ink"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="border-t border-hairline">
        <div className="mx-auto max-w-[1120px] px-6 py-4">
          <p className="text-[13px] text-muted">
            &copy; <span className="tnum">{year}</span> {brand.name}. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}

export default SiteFooter;
