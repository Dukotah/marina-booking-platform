import { cn } from './cn.js';

export interface TabItem {
  /** Unique identifier for the tab; matched against `value`. */
  value: string;
  /** Visible tab label. */
  label: React.ReactNode;
  /** Optionally disable selection of this tab. */
  disabled?: boolean;
}

export interface TabsProps {
  /** Currently selected tab value (controlled). */
  value: string;
  /** Called with the new value when a tab is activated. */
  onValueChange: (value: string) => void;
  /** The tabs to render. */
  items: TabItem[];
  /** Accessible label for the tab list. */
  'aria-label'?: string;
  className?: string;
}

/**
 * A controlled tab strip. Renders the tab list only — consumers render the
 * active panel themselves based on `value`. Implements arrow-key roving focus
 * per the WAI-ARIA tabs pattern.
 */
export function Tabs({
  value,
  onValueChange,
  items,
  className,
  'aria-label': ariaLabel,
}: TabsProps): React.ReactElement {
  const enabled = items.filter((i) => !i.disabled);

  const focusByValue = (v: string, container: HTMLElement | null) => {
    container
      ?.querySelector<HTMLButtonElement>(`[data-tab-value="${v}"]`)
      ?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (enabled.length === 0) return;
    const currentIndex = enabled.findIndex((i) => i.value === value);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % enabled.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + enabled.length) % enabled.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = enabled.length - 1;
    }
    if (nextIndex !== null) {
      const next = enabled[nextIndex];
      if (next) {
        event.preventDefault();
        onValueChange(next.value);
        focusByValue(next.value, event.currentTarget);
      }
    }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1',
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            data-tab-value={item.value}
            aria-selected={selected}
            disabled={item.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => !item.disabled && onValueChange(item.value)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-color,#0f766e)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
              selected
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
