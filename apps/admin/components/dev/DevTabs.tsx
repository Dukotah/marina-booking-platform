'use client';

/**
 * Tab shell for the Local Console. Each tab's contents are rendered on the server
 * and handed in as a `ReactNode`, so this component only decides which one is on
 * screen — no data fetching, no client-side re-render of a table.
 *
 * The active tab is mirrored into the URL hash so a reload (or a link the owner
 * sends himself) lands back where he was. It is read in an effect rather than in
 * the initial state so the server and client render the same first frame.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface DevTab {
  key: string;
  label: string;
  /** Small count beside the label. Omit for tabs that aren't a list. */
  count?: number;
  /** Draws the pill in amber — used when something is queued and waiting. */
  highlight?: boolean;
  content: ReactNode;
}

export interface DevTabsProps {
  tabs: DevTab[];
}

export function DevTabs({ tabs }: DevTabsProps) {
  const [active, setActive] = useState(tabs[0]?.key ?? '');

  useEffect(() => {
    const fromHash = window.location.hash.replace(/^#/, '');
    if (fromHash && tabs.some((t) => t.key === fromHash)) setActive(fromHash);
    // Tabs are static for the life of the page; this restores the deep link once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function select(key: string) {
    setActive(key);
    // replaceState, not a router push: switching tabs should not add history
    // entries the back button has to chew through.
    window.history.replaceState(null, '', `#${key}`);
  }

  const current = tabs.find((t) => t.key === active) ?? tabs[0];

  return (
    <div className="space-y-5">
      <div
        role="tablist"
        aria-label="Local Console sections"
        className="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-3"
      >
        {tabs.map((t) => {
          const isActive = current?.key === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`dev-tab-${t.key}`}
              aria-selected={isActive}
              aria-controls={`dev-panel-${t.key}`}
              onClick={() => select(t.key)}
              className={cn(
                'rounded-full px-3.5 py-1.5 text-sm font-medium transition',
                isActive
                  ? 'bg-slate-900 text-white'
                  : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50',
              )}
            >
              {t.label}
              {typeof t.count === 'number' ? (
                <span
                  className={cn(
                    'ml-1.5',
                    isActive
                      ? 'opacity-60'
                      : t.highlight
                        ? 'rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800'
                        : 'opacity-60',
                  )}
                >
                  {t.count}
                </span>
              ) : t.highlight && !isActive ? (
                // A tab with nothing to count can still be "armed" — the clock
                // being off real time is the case this exists for.
                <span
                  aria-label="active"
                  className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {current ? (
        <div
          role="tabpanel"
          id={`dev-panel-${current.key}`}
          aria-labelledby={`dev-tab-${current.key}`}
        >
          {current.content}
        </div>
      ) : null}
    </div>
  );
}
