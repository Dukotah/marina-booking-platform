import Link from 'next/link';
import type { Metadata } from 'next';
import { getPackages, type CatalogPackage } from '@/lib/api';
import { getBrandAsync, brandStyle } from '@/lib/brand';
import { formatUSD } from '@/lib/format';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';

export const metadata: Metadata = {
  title: 'Packages',
  description: 'Bundle experiences at a single discounted price.',
};

export const dynamic = 'force-dynamic';

/**
 * Customer-facing package catalog: the operator's active, online-visible bundles,
 * each showing its bundle price and the savings versus booking the items
 * separately. Cards link to the package detail page.
 */
export default async function PackagesPage() {
  const brand = await getBrandAsync();

  let packages: CatalogPackage[] = [];
  let loadFailed = false;
  try {
    packages = await getPackages();
  } catch {
    loadFailed = true;
  }

  return (
    <div style={brandStyle(brand)} className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="flex-1">
        <div className="mx-auto max-w-[1120px] px-6 py-16">
          <header className="mb-10">
            <h1 className="text-3xl font-bold tracking-tight text-ink">Packages</h1>
            <p className="mt-2 text-muted">
              Bundle your favorite experiences at a single price and save.
            </p>
          </header>

          {loadFailed || packages.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-hairline bg-surface p-10 text-center text-muted">
              {loadFailed
                ? 'We could not load packages right now. Please try again shortly.'
                : 'No packages are available right now. Check back soon.'}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {packages.map((pkg) => (
                <PackageCard key={pkg.id} pkg={pkg} />
              ))}
            </div>
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

function PackageCard({ pkg }: { pkg: CatalogPackage }) {
  return (
    <Link
      href={`/packages/${encodeURIComponent(pkg.id)}`}
      className="group flex h-full flex-col rounded-2xl border border-hairline bg-surface p-5 shadow-sm transition hover:border-[var(--brand-color)] hover:shadow-md"
    >
      <h2 className="text-lg font-semibold text-ink">{pkg.name}</h2>
      <p className="mt-1 text-sm text-muted">
        {pkg.items.length} experience{pkg.items.length === 1 ? '' : 's'} included
      </p>
      <div className="mt-auto pt-4">
        <p className="text-sm text-ink">
          <span className="tnum text-xl font-bold">{formatUSD(pkg.priceCents)}</span>
        </p>
        {pkg.savingsCents > 0 ? (
          <p className="mt-0.5 text-sm font-medium text-emerald-700">
            Save {formatUSD(pkg.savingsCents)}
          </p>
        ) : null}
      </div>
    </Link>
  );
}
