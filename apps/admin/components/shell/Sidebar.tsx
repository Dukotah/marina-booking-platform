'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  CalendarDays,
  LayoutDashboard,
  ListChecks,
  Receipt,
  Sailboat,
  Users,
  ScanLine,
  BarChart3,
  UserCog,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/cn';

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

/**
 * Primary admin navigation. One app, one login, role-filtered views — the
 * deliberate contrast to Singenuity's three separate apps. White-label: the
 * brand name in the rail comes from operator data passed by the shell, never a
 * hardcoded platform name.
 */
const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard },
  { label: 'Manifest', href: '/manifest', icon: ListChecks },
  { label: 'Calendar', href: '/calendar', icon: CalendarDays },
  { label: 'Orders', href: '/orders', icon: Receipt },
  { label: 'Activities', href: '/activities', icon: Sailboat },
  { label: 'Customers', href: '/customers', icon: Users },
  { label: 'POS', href: '/pos', icon: ScanLine },
  { label: 'Reports', href: '/reports', icon: BarChart3 },
  { label: 'Staff', href: '/staff', icon: UserCog },
  { label: 'Settings', href: '/settings', icon: Settings },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export interface SidebarProps {
  /** Operator display name (white-label). */
  brandName: string;
  /** Optional operator logo (light variant, shown on the dark rail). */
  logoUrl?: string | null;
  /** Show the platform (super-admin) entry point. */
  showPlatformLink?: boolean;
}

export function Sidebar({ brandName, logoUrl, showPlatformLink = false }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-900 text-slate-300 md:flex">
      <div className="flex h-16 items-center gap-2 border-b border-slate-800 px-5">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={brandName} className="h-8 w-auto object-contain" />
        ) : (
          <span className="truncate text-lg font-semibold text-white">{brandName}</span>
        )}
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-white',
              )}
            >
              <Icon className="h-5 w-5 shrink-0" aria-hidden />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {showPlatformLink && (
        <div className="border-t border-slate-800 p-3">
          <Link
            href="/platform"
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/10"
          >
            <ShieldCheck className="h-5 w-5 shrink-0" aria-hidden />
            <span>Platform</span>
          </Link>
        </div>
      )}

      <div className="border-t border-slate-800 p-4 text-xs text-slate-500">
        Powered by your team
      </div>
    </aside>
  );
}
