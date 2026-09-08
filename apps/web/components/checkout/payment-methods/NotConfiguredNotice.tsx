'use client';

/**
 * The "none" fallback of the PaymentMethodInput set: online card capture is not
 * wired for this site and reserve mode is off. Renders a clear notice instead of
 * a card field; the checkout guards submit in this state, so no imperative handle
 * is exposed (there is nothing to tokenize).
 */
import { AlertTriangle } from 'lucide-react';

export function NotConfiguredNotice() {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
        <div className="space-y-1 text-sm">
          <p className="font-semibold text-amber-900">Payments not configured</p>
          <p className="text-amber-800">
            Card payments are not set up for this site yet. Add a Stripe publishable
            key to enable secure checkout. Until then, bookings cannot be paid online
            here.
          </p>
        </div>
      </div>
    </div>
  );
}
