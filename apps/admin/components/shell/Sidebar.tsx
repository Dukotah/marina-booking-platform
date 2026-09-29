'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  CalendarDays,
  ListChecks,
  Receipt,
  Sailboat,
  Users,
  ScanLine,
  BarChart3,
  Settings,
  ShieldCheck,
  FlaskConical,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/cn';

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /**
   * Extra path prefixes that light this item up. Catalog owns the old
   * /activities, /gift-certificates and /memberships detail routes; Settings
   * owns /staff — the pages moved, the deep links did not.
   */
  also?: string[];
}

interface NavSection {
  /** Small uppercase section label. */
  label: string;
  items: NavItem[];
}

/**
 * Primary admin navigation. One app, one login, role-filtered views — the
 * deliberate contrast to Singenuity's three separate apps. White-label: the
 * brand name in the rail comes from operator data passed by the shell, never a
 * hardcoded platform name.
 *
 * Three sections, eight items — grouped by the job being done, not by feature
 * count. The Dashboard has no row of its own: the brand at the top of the rail
 * is the way home, the same convention as every web app the staff already use.
 */
const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Run the day',
    items: [
      { label: 'Manifest', href: '/manifest', icon: ListChecks },
      { label: 'Calendar', href: '/calendar', icon: CalendarDays },
      { label: 'POS', href: '/pos', icon: ScanLine },
    ],
  },
  {
    label: 'Sell',
    items: [
      { label: 'Orders', href: '/orders', icon: Receipt },
      { label: 'Customers', href: '/customers', icon: Users },
      {
        label: 'Catalog',
        href: '/catalog',
        icon: Sailboat,
        also: ['/activities', '/gift-certificates', '/memberships'],
      },
    ],
  },
  {
    label: 'Back office',
    items: [
      { label: 'Reports', href: '/reports', icon: BarChart3 },
      { label: 'Settings', href: '/settings', icon: Settings, also: ['/staff'] },
    ],
  },
];

function matchesHref(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function isActive(pathname: string, item: NavItem): boolean {
  if (matchesHref(pathname, item.href)) return true;
  return (item.also ?? []).some((prefix) => matchesHref(pathname, prefix));
}

export interface SidebarProps {
  /** Operator display name (white-label). */
  brandName: string;
  /** Optional operator logo (light variant, shown on the dark rail). */
  logoUrl?: string | null;
  /** Show the platform (super-admin) entry point. */
  showPlatformLink?: boolean;
  /** Show the Local Console link (sandbox runs only). */
  showDevConsole?: boolean;
}

export function Sidebar({
  brandName,
  logoUrl,
  showPlatformLink = false,
  showDevConsole = false,
}: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-900 text-slate-300 md:flex">
      {/* The brand IS the dashboard link — one fewer nav row, same muscle memory
          as every SaaS the crew already uses. Named for what it does, not what
          it shows, so a screen reader hears the destination. */}
      <Link
        href="/"
        aria-label={`${brandName} — dashboard`}
        aria-current={pathname === '/' ? 'page' : undefined}
        className="flex h-16 items-center gap-2 border-b border-slate-800 px-5 transition-colors hover:bg-slate-800/60 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-400"
      >
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={brandName} className="h-8 w-auto object-contain" />
        ) : (
          <span className="truncate text-lg font-semibold text-white">{brandName}</span>
        )}
      </Link>

      <nav className="flex-1 space-y-5 overflow-y-auto p-3">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label}>
            {/* slate-400, not slate-500: on the dark rail slate-500 is 3.75:1,
                under the 4.5:1 floor (1.4.3) — same rule as the footer below. */}
            <h2 className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              {section.label}
            </h2>
            <div className="space-y-1">
              {section.items.map((item) => {
                const active = isActive(pathname, item);
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
            </div>
          </div>
        ))}
      </nav>

      {showDevConsole && (
        <div className="border-t border-slate-800 p-3">
          <Link
            href="/dev"
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-amber-300 transition-colors hover:bg-amber-500/10"
          >
            <FlaskConical className="h-5 w-5 shrink-0" aria-hidden />
            <span>Local Console</span>
          </Link>
        </div>
      )}

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

      {/* slate-400, not slate-500: on the dark rail (bg-slate-900) slate-500 is
          3.75:1, under the 4.5:1 floor. slate-400 is 6.9:1 there. The rail inverts,
          so the safe grey inverts with it. (1.4.3) */}
      <div className="border-t border-slate-800 p-4 text-xs text-slate-400">
        &copy; {new Date().getFullYear()} {brandName}
      </div>
    </aside>
  );
}
