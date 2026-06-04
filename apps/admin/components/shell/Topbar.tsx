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
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-slate-200 bg-white px-4 md:px-6">
      <span className="text-base font-semibold text-slate-900 md:hidden">{brandName}</span>

      <div className="relative hidden flex-1 md:block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <input
          type="search"
          placeholder="Search orders, customers, activities…"
          className="w-full max-w-md rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-slate-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-200"
        />
      </div>

      <div className="ml-auto flex items-center gap-3">
        <button
          type="button"
          aria-label="Notifications"
          className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
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
            <div className="text-sm font-medium text-slate-900">{userName}</div>
            <div className="text-xs text-slate-500">{roleLabel}</div>
          </div>
        </div>
      </div>
    </header>
  );
}
