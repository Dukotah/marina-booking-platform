import type { Metadata } from 'next';
import { getBrand } from '@/lib/brand';
import './globals.css';

/**
 * Per-tenant metadata — the browser tab title / share title must be the OPERATOR's
 * brand, never a platform default (white-label). Resolved from the operator the API
 * maps from the host/slug; falls back to the neutral brand default when unresolved.
 */
export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrand();
  return {
    title: {
      default: brand.name,
      template: `%s · ${brand.name}`,
    },
    description: brand.tagline ?? `Book with ${brand.name}.`,
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
