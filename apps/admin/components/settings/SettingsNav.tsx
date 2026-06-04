'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Palette,
  ShieldCheck,
  Receipt,
  MapPin,
  Plug,
  UserCog,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/cn';

interface SettingsTab {
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
}

/**
 * Grouped settings navigation — the deliberate contrast to Singenuity's 18+
 * unsearchable settings pages. A small, sensible set of groups instead of a
 * sprawling list. "Staff" links into the dedicated staff slice.
 */
export const SETTINGS_TABS: SettingsTab[] = [
  { label: 'Branding', href: '/settings/branding', icon: Palette, description: 'Name, logo, brand color' },
  { label: 'Policies', href: '/settings/policies', icon: ShieldCheck, description: 'Adult age, cancellation, check-in' },
  { label: 'Fees & Taxes', href: '/settings/fees', icon: Receipt, description: 'Taxes, processing, custom fees' },
  { label: 'Locations', href: '/settings/locations', icon: MapPin, description: 'Sites & addresses' },
  { label: 'Integrations', href: '/settings/integrations', icon: Plug, description: 'Payments, accounting, marketing' },
  { label: 'Staff', href: '/staff', icon: UserCog, description: 'Team members & roles' },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav className="mb-6 flex flex-wrap gap-2" aria-label="Settings sections">
      {SETTINGS_TABS.map((tab) => {
        const active = isActive(pathname, tab.href);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors',
              active
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900',
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
