import type { Metadata } from 'next';
import './globals.css';
import { getBrandAsync } from '@/lib/brand';

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
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
