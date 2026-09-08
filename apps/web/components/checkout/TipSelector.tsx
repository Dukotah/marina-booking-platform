'use client';

/**
 * Gratuity selector with preset percentages (15 / 20 / 25%) plus a custom dollar
 * amount and a "no tip" option. The tip is computed in integer cents off the
 * post-discount base so it tracks promos applied above. The parent owns the tip
 * value; this component only reports changes.
 */
import { useId } from 'react';
import { formatUSD, roundCents, toCents } from '@marina/core';
import { cn } from '@marina/ui';

const PRESETS = [15, 20, 25] as const;

interface TipSelectorProps {
  /** Base amount (post-discount subtotal) the percentage presets apply to, in cents. */
  baseCents: number;
  /** Currently selected tip in integer cents. */
  tipCents: number;
  onChange: (tipCents: number) => void;
}

export function TipSelector({ baseCents, tipCents, onChange }: TipSelectorProps) {
  const customId = useId();

  const presetCents = (pct: number) => roundCents((baseCents * pct) / 100);
  const isPresetActive = (pct: number) => tipCents > 0 && tipCents === presetCents(pct);
  const isNoneActive = tipCents <= 0;
  const isCustomActive =
    tipCents > 0 && !PRESETS.some((pct) => tipCents === presetCents(pct));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <button
          type="button"
          onClick={() => onChange(0)}
          aria-pressed={isNoneActive}
          className={cn(
            'rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
            isNoneActive
              ? 'border-accent bg-surface text-ink'
              : 'border-hairline bg-surface text-ink hover:bg-bg',
          )}
        >
          No tip
        </button>
        {PRESETS.map((pct) => (
          <button
            key={pct}
            type="button"
            onClick={() => onChange(presetCents(pct))}
            aria-pressed={isPresetActive(pct)}
            className={cn(
              'flex flex-col items-center rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
              isPresetActive(pct)
                ? 'border-accent bg-surface text-ink'
                : 'border-hairline bg-surface text-ink hover:bg-bg',
            )}
          >
            <span>{pct}%</span>
            <span className="tnum text-xs font-normal text-muted">
              {formatUSD(presetCents(pct))}
            </span>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor={customId} className="text-sm text-muted">
          Custom
        </label>
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">
            $
          </span>
          <input
            id={customId}
            inputMode="decimal"
            type="number"
            min={0}
            step="0.01"
            placeholder="0.00"
            value={isCustomActive ? (tipCents / 100).toString() : ''}
            onChange={(e) => {
              const dollars = Number.parseFloat(e.target.value);
              onChange(Number.isFinite(dollars) && dollars > 0 ? toCents(dollars) : 0);
            }}
            className={cn(
              'tnum h-10 w-full rounded-lg border border-hairline bg-surface pl-7 pr-3 text-sm text-ink',
              'placeholder:text-muted',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-color,#0f766e)] focus-visible:ring-offset-2',
            )}
          />
        </div>
      </div>
    </div>
  );
}
