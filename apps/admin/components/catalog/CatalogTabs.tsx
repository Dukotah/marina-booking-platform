'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Sailboat, Gift, Ticket, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

interface CatalogTab {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Old routes that still resolve here (detail pages kept their deep links). */
  also: string[];
}

/**
 * Catalog sub-navigation — Boats & Listings, Gift certificates and Memberships
 * as tabs of ONE nav destination, instead of three top-level sidebar rows.
 * Same pattern as SettingsNav: real links, aria-current, pathname-driven.
 */
const CATALOG_TABS: CatalogTab[] = [
  { label: 'Boats & Listings', href: '/catalog', icon: Sailboat, also: ['/activities'] },
  {
    label: 'Gift certificates',
    href: '/catalog/gift-certificates',
    icon: Gift,
    also: ['/gift-certificates'],
  },
  { label: 'Memberships', href: '/catalog/memberships', icon: Ticket, also: ['/memberships'] },
];

function matches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isActive(pathname: string, tab: CatalogTab): boolean {
  // "/catalog" is a prefix of every other tab, so it only wins exactly.
  if (tab.href === '/catalog') {
    return pathname === '/catalog' || tab.also.some((p) => matches(pathname, p));
  }
  return matches(pathname, tab.href) || tab.also.some((p) => matches(pathname, p));
}

export function CatalogTabs() {
  const pathname = usePathname();

  return (
    <nav className="mb-6 flex flex-wrap gap-2" aria-label="Catalog sections">
      {CATALOG_TABS.map((tab) => {
        const active = isActive(pathname, tab);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-11 items-center gap-2 rounded-lg border px-3.5 text-sm font-medium transition-colors',
              active
                ? 'border-accent bg-accent-tint text-accent-ink'
                : 'border-line bg-surface text-ink-body hover:bg-surface-muted hover:text-ink',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
