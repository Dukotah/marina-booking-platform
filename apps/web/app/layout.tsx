import type { Metadata } from 'next';
import './globals.css';
import { getBrand } from '@/lib/brand';

// White-label the browser title/description from the resolved tenant brand,
// so the tab reads as the operator (e.g. "Lake Sonoma Marina"), never a
// generic platform name. Per-request so multi-tenant deploys resolve correctly.
export function generateMetadata(): Metadata {
  const brand = getBrand();
  return {
    title: brand.tagline ? `${brand.name} — ${brand.tagline}` : brand.name,
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
