'use client';

import { useState, useTransition } from 'react';
import { setCustomerTaxExempt, type ActionResult } from '../../app/customers/[id]/actions';

export interface TaxExemptToggleProps {
  customerId: string;
  initialTaxExempt: boolean;
  /** When false, renders read-only (no customer:write permission). */
  canEdit: boolean;
}

/**
 * Tax-exempt switch for the customer profile. When on, the shared pricing engine
 * skips any fee flagged `is_tax` for this customer's orders. Persists through the
 * customer:write server action with inline feedback.
 */
export function TaxExemptToggle({ customerId, initialTaxExempt, canEdit }: TaxExemptToggleProps) {
  const [exempt, setExempt] = useState(initialTaxExempt);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggle(next: boolean) {
    if (isPending) return;
    setStatus('idle');
    setError(null);
    const prev = exempt;
    setExempt(next);
    startTransition(async () => {
      const result: ActionResult = await setCustomerTaxExempt(customerId, next);
      if (result.ok) {
        setStatus('saved');
      } else {
        setExempt(prev);
        setStatus('error');
        setError(result.error ?? 'Failed to update.');
      }
    });
  }

  if (!canEdit) {
    return (
      <p className="text-sm text-ink-body">
        {exempt ? 'Tax-exempt — no tax charged.' : 'Not tax-exempt.'}
      </p>
    );
  }

  return (
    <div>
      <label className="flex min-h-[44px] cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={exempt}
          disabled={isPending}
          onChange={(e) => toggle(e.target.checked)}
          className="h-5 w-5 rounded border-line text-accent focus:ring-2 focus:ring-focus"
        />
        <span className="text-sm text-ink">
          Tax-exempt
          <span className="block text-xs text-ink-muted">
            Skip sales tax on this customer&rsquo;s orders.
          </span>
        </span>
      </label>
      <div className="mt-1 text-xs">
        {status === 'saved' ? <span className="text-emerald-600">Saved.</span> : null}
        {status === 'error' ? <span className="text-rose-600">{error}</span> : null}
      </div>
    </div>
  );
}
