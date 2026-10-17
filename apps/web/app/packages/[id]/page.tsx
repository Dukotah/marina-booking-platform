import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getPackage, isApiError, type CatalogPackage } from '@/lib/api';
import { getBrandAsync, brandStyle } from '@/lib/brand';
import { formatUSD } from '@/lib/format';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';

interface PageProps {
  params: { id: string };
}

async function loadPackage(id: string): Promise<CatalogPackage | null> {
  try {
    return await getPackage(id);
  } catch (err) {
    if (isApiError(err) && err.status === 404) return null;
    throw err;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const pkg = await loadPackage(params.id);
  if (!pkg) return { title: 'Package not found' };
  return { title: pkg.name, description: `Bundle price ${formatUSD(pkg.priceCents)}.` };
}

export const dynamic = 'force-dynamic';

/**
 * Customer-facing package detail. Shows the bundle contents (each component
 * activity/rate + quantity with its à-la-carte line total), the single bundle
 * price, and the advertised savings. Booking a package as a unit is not yet
 * wired — the CTA points customers at the component activities to book.
 */
export default async function PackageDetailPage({ params }: PageProps) {
  const pkg = await loadPackage(params.id);
  if (!pkg) notFound();

  const brand = await getBrandAsync();

  return (
    <div style={brandStyle(brand)} className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="flex-1">
        <div className="mx-auto max-w-[760px] px-6 py-12">
          <Link href="/packages" className="text-sm font-medium text-muted hover:text-ink">
            ← All packages
          </Link>

          <header className="mt-4">
            <h1 className="text-3xl font-bold tracking-tight text-ink">{pkg.name}</h1>
            {pkg.descriptionHtml ? (
              <div
                className="prose prose-sm mt-3 max-w-none text-muted"
                // Description is operator-authored rich text, sanitized server-side.
                dangerouslySetInnerHTML={{ __html: pkg.descriptionHtml }}
              />
            ) : null}
          </header>

          <section className="mt-8 rounded-2xl border border-hairline bg-surface p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
              What's included
            </h2>
            <ul className="mt-3 divide-y divide-hairline">
              {pkg.items.map((item) => (
                <li key={item.id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-medium text-ink">
                      {item.quantity > 1 ? `${item.quantity}× ` : ''}
                      {item.activityName}
                    </p>
                    <p className="text-sm text-muted">{item.rateName}</p>
                  </div>
                  <span className="tnum text-sm text-muted">
                    {formatUSD(item.lineTotalCents)}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-6 rounded-2xl border border-hairline bg-surface p-5">
            <div className="flex items-center justify-between text-sm text-muted">
              <span>À la carte total</span>
              <span className="tnum line-through">{formatUSD(pkg.aLaCarteCents)}</span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-lg font-semibold text-ink">Package price</span>
              <span className="tnum text-2xl font-bold text-ink">
                {formatUSD(pkg.priceCents)}
              </span>
            </div>
            {pkg.savingsCents > 0 ? (
              <p className="mt-1 text-right text-sm font-medium text-emerald-700">
                You save {formatUSD(pkg.savingsCents)}
              </p>
            ) : null}
          </section>

          <section className="mt-6 rounded-2xl border border-dashed border-hairline bg-bg p-5 text-sm text-muted">
            <p className="font-medium text-ink">Ready to book?</p>
            <p className="mt-1">
              This bundle includes the experiences listed above. Booking a package as a
              single checkout is coming soon — in the meantime, browse and reserve each
              included experience from the{' '}
              <Link href="/" className="font-medium underline">
                booking page
              </Link>
              .
            </p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
