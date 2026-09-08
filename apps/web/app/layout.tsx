import type { Metadata } from 'next';
import { Figtree, Marcellus } from 'next/font/google';
import './globals.css';
import { getBrandAsync } from '@/lib/brand';

/*
 * "Estate" type pairing (DESIGN.md): Marcellus for display (one weight, 400),
 * Figtree for UI/body. Self-hosted via next/font (never a <link> tag), exposed
 * as CSS variables consumed by Tailwind's `font-display` / `font-sans`.
 */
const display = Marcellus({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  variable: '--font-display',
});

const ui = Figtree({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-ui',
});

// White-label the browser title/description from the resolved tenant brand,
// so the tab reads as the operator (e.g. "Lake Sonoma Marina"), never a
// generic platform name. Per-request so multi-tenant deploys resolve correctly.
// Brand is fetched from the operator record (getBrandAsync), env/base fallback.
export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrandAsync();
  return {
    title: {
      // The home/default tab title (used when a page sets no title of its own).
      default: brand.tagline ? `${brand.name} — ${brand.tagline}` : brand.name,
      // Any child page that sets a plain string title gets the operator name
      // appended, so /terms, /privacy, /account, etc. read e.g. "Terms of Service
      // · Lake Sonoma Marina" instead of an unbranded tab. Pages that build their
      // own fully-branded title (activity, confirmation) opt out via title.absolute.
      template: `%s · ${brand.name}`,
    },
    description:
      brand.tagline ?? `Reserve boats, watercraft, and waterfront venues with ${brand.name}.`,
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable}`}>
      {/* Estate page canvas: warm cream, espresso ink, Figtree UI face. */}
      <body className="min-h-screen bg-bg font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
