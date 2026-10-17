import Link from 'next/link';
import { getBrand, brandStyle } from '@/lib/brand';

export default function PackageNotFound() {
  const brand = getBrand();
  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={brandStyle(brand)}
      className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center"
    >
      <h1 className="mt-5 text-2xl font-bold tracking-tight text-ink">
        We couldn&apos;t find that package
      </h1>
      <p className="mt-2 text-muted">
        It may no longer be available. Browse our current packages instead.
      </p>
      <Link
        href="/packages"
        className="mt-6 rounded-xl px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
        style={{ backgroundColor: 'var(--brand-color)' }}
      >
        See all packages
      </Link>
    </main>
  );
}
