'use client';

import { useState } from 'react';
import { Gift, Plus } from 'lucide-react';
import { toCents } from '@marina/core';
import type { CartLine } from './types';

/**
 * Gift / misc charge tab. For one-off sales that aren't an activity or a catalogued
 * merchandise item — gift cards, late fees, lost-key charges, custom add-ons. The
 * operator types a description and a dollar amount; it's added to the cart as a MISC
 * line. Amounts are entered in dollars and converted to integer cents here.
 */
export interface MiscTabProps {
  onAdd: (line: Omit<CartLine, 'key'>) => void;
}

export function MiscTab({ onAdd }: MiscTabProps) {
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  function add() {
    const trimmed = label.trim();
    const dollars = Number.parseFloat(amount);
    if (!trimmed) {
      setError('Enter a description.');
      return;
    }
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setError('Enter an amount greater than $0.');
      return;
    }
    onAdd({
      kind: 'MISC',
      label: trimmed,
      sublabel: 'Gift / misc',
      unitPriceCents: toCents(dollars),
      quantity: 1,
    });
    setLabel('');
    setAmount('');
    setError(null);
  }

  return (
    <div className="max-w-md space-y-4">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Gift className="h-4 w-4" aria-hidden />
        Gift cards, custom charges, and one-off items.
      </div>

      <div>
        <label
          htmlFor="misc-label"
          className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500"
        >
          Description
        </label>
        <input
          id="misc-label"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. $50 Gift Card"
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
        />
      </div>

      <div>
        <label
          htmlFor="misc-amount"
          className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500"
        >
          Amount
        </label>
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
            $
          </span>
          <input
            id="misc-amount"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-7 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
          />
        </div>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <button
        type="button"
        onClick={add}
        className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-emerald-500"
      >
        <Plus className="h-4 w-4" aria-hidden />
        Add to cart
      </button>
    </div>
  );
}
