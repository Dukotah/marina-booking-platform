'use client';

/**
 * No-card implementation of the PaymentMethodInput contract — used for BOTH
 * reserve mode (a first-class, customer-presentable way to run a marina that takes
 * payment on arrival) and the sandbox/fake-payments path (local simulator with no
 * key). It satisfies the same imperative handle as the live card form, returning a
 * placeholder source the API's no-card path accepts, and presents the flow to the
 * guest as a reserve-now, pay-at-the-marina booking. Customer-facing copy NEVER
 * mentions dev/simulated/fake/test payments.
 */
import { forwardRef, useImperativeHandle } from 'react';
import { CreditCard } from 'lucide-react';
import { formatUSD } from '@marina/core';
import type { PaymentMethodInputHandle } from './types';

export const ReserveAtMarinaInput = forwardRef<PaymentMethodInputHandle, { dueCents?: number }>(
  function ReserveAtMarinaInput({ dueCents }, ref) {
    // No card is taken here — the parent skips tokenize entirely in reserve mode —
    // but the handle is still satisfied so the ref contract holds.
    useImperativeHandle(
      ref,
      () => ({
        isReady: () => true,
        tokenize: async () => ({ ok: true as const, sourceId: '' }),
      }),
      [],
    );
    return (
      <div className="rounded-lg border border-hairline bg-bg p-4">
        <div className="flex items-start gap-3">
          <CreditCard className="mt-0.5 h-5 w-5 shrink-0 text-accent-ink" aria-hidden />
          <div className="space-y-2 text-sm">
            <p className="font-semibold text-ink">Reserve now, pay at the marina</p>
            <p className="text-muted">
              No card needed to hold your spot. Confirm your booking below and pay
              when you arrive.
            </p>
            {typeof dueCents === 'number' && dueCents > 0 && (
              <p className="flex items-baseline justify-between gap-4 rounded-lg border border-hairline bg-surface px-3 py-2 font-medium text-ink">
                <span>Due at the marina</span>
                <span className="tnum font-semibold">{formatUSD(dueCents)}</span>
              </p>
            )}
            <p className="text-xs text-muted">
              Bring a photo ID and your order number. Cash and card are accepted at
              check-in.
            </p>
          </div>
        </div>
      </div>
    );
  },
);
