'use client';

/**
 * Express wallet (Apple Pay / Google Pay) seam.
 *
 * Deliberately a *placeholder seam*, not a live wallet: it renders an "express
 * checkout" affordance only when the wallet flag is enabled, and exposes an
 * `onExpressPay` hook the parent can wire to a real PaymentRequest button later.
 * With no real integration yet, the buttons are shown disabled with a "coming
 * soon" hint, so the layout, spacing, and divider are already correct for when
 * the real wallet lands — no future reflow / layout shift.
 *
 * When `enabled` is false this returns null (renders nothing), so it is a true
 * no-op behind the flag.
 */

import { Apple, Wallet } from 'lucide-react';

interface WalletExpressProps {
  /** Gate: only render when the wallet seam is turned on. */
  enabled: boolean;
  /**
   * Future hook point. When a real wallet integration is added, this fires with
   * the chosen wallet so the parent can trigger the PaymentRequest flow. Left
   * optional so the seam is inert until wired.
   */
  onExpressPay?: (wallet: 'apple' | 'google') => void;
}

export function WalletExpress({ enabled, onExpressPay }: WalletExpressProps) {
  if (!enabled) return null;

  // Until a real wallet is wired, the express buttons are inert. The seam keeps
  // the exact final layout so enabling it later causes no visual shift.
  const ready = typeof onExpressPay === 'function';

  return (
    <div className="space-y-3" aria-label="Express checkout">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          type="button"
          disabled={!ready}
          onClick={ready ? () => onExpressPay?.('apple') : undefined}
          className="flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-black px-4 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Apple className="h-4 w-4" aria-hidden />
          Apple&nbsp;Pay
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={ready ? () => onExpressPay?.('google') : undefined}
          className="flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Wallet className="h-4 w-4" aria-hidden />
          Google&nbsp;Pay
        </button>
      </div>

      {!ready && (
        <p className="text-center text-xs text-slate-400">
          Express wallet checkout is coming soon.
        </p>
      )}

      {/* "or pay with card" divider — keeps the card section visually secondary. */}
      <div className="flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-slate-400">
        <span className="h-px flex-1 bg-slate-200" aria-hidden />
        or pay with card
        <span className="h-px flex-1 bg-slate-200" aria-hidden />
      </div>
    </div>
  );
}

export default WalletExpress;
