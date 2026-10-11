import { Bell, Search } from 'lucide-react';

export interface TopbarProps {
  /** Operator display name (white-label) — shown on mobile where the rail is hidden. */
  brandName: string;
  /** Authenticated staff member's display name. */
  userName: string;
  /** Staff role label (e.g. "Owner"). */
  roleLabel: string;
}

/**
 * Slim top bar: brand on mobile, a search affordance, notifications, and the
 * signed-in staff identity. Auth/sign-out wiring is owned by Clerk's components
 * mounted by page slices; this is the static chrome.
 */
export function Topbar({ brandName, userName, roleLabel }: TopbarProps) {
  const initials = userName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line bg-surface px-4 md:px-6">
      <span className="text-base font-semibold text-ink md:hidden">{brandName}</span>

      <div className="relative hidden flex-1 md:block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" aria-hidden />
        <input
          type="search"
          // A placeholder is not a label: it is the fallback name source, and it
          // disappears the moment the field has content. (4.1.2)
          aria-label="Search orders, customers and activities"
          placeholder="Search orders, customers, activities…"
          className="h-10 w-full max-w-md rounded-lg border border-line bg-surface-muted pl-9 pr-3 text-sm text-ink placeholder:text-ink-muted transition-colors focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-focus"
        />
      </div>

      <div className="ml-auto flex items-center gap-3">
        <button
          type="button"
          aria-label="Notifications"
          className="rounded-lg p-2 text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
        >
          <Bell className="h-5 w-5" aria-hidden />
        </button>

        <div className="flex items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white"
            aria-hidden
          >
            {initials || '–'}
          </div>
          <div className="hidden leading-tight sm:block">
            <div className="text-sm font-medium text-ink">{userName}</div>
            <div className="text-xs text-ink-muted">{roleLabel}</div>
          </div>
        </div>
      </div>
    </header>
  );
}
