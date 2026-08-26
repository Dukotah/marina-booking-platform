'use client';

/**
 * Express wallet checkout (Apple Pay / Google Pay).
 *
 * This renders the button and owns the UI states; everything about the wallet
 * itself lives in `./walletRequest`. Three rules shape it:
 *
 * 1. **It is not a second checkout.** The wallet only produces a payment token.
 *    Settling it is delegated straight back to the parent via `onWalletPayment`,
 *    which runs the exact same validate -> createBooking -> submitPayment pipeline
 *    the card button runs. Same totals, same waiver, same order — the only thing
 *    that changed is where the card came from.
 *
 * 2. **canMakePayment decides whether a button exists at all.** A device with no
 *    enrolled wallet renders nothing: no disabled button, no divider, no hint.
 *    Offering a wallet that cannot pay is worse than not offering one.
 *
 * 3. **Absent config or flag is a clean no-op.** With `enabled` false it returns
 *    null. Wired up but with nothing to charge, or a browser that cannot pay, it
 *    also returns null. Nothing here can throw into the checkout render tree.
 *
 * Left unwired (only `enabled` passed, which is how the seam originally shipped)
 * it keeps the previous disabled placeholder, so the checkout layout is identical
 * before and after the parent passes the real props.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Apple, Loader2, Wallet } from 'lucide-react';
import { formatUSD } from '@marina/core';
import type { WalletConfig } from '@/app/checkout/wallet-config';
import {
  createWalletDriver,
  type SandboxSheetChoice,
  type SandboxSheetRequest,
  type WalletDriver,
  type WalletPayment,
  type WalletSettleResult,
  type WalletTotals,
} from './walletRequest';

interface WalletExpressProps {
  /** Gate: only attempt a wallet when the seam is turned on. */
  enabled: boolean;
  /** Resolved server-side wallet config. Absent keeps the seam inert. */
  config?: WalletConfig;
  /**
   * The amount to authorize, built from the same `calculatePricing` result the
   * on-page breakdown renders (see `walletTotalsFromPricing`).
   */
  totals?: WalletTotals;
  /** The single line naming the purchase on the wallet sheet. */
  itemLabel?: string;
  /**
   * Non-null blocks express pay with this reason — e.g. an unsigned waiver.
   * Checked synchronously so the click still opens the sheet within the user
   * gesture when it is null; the parent must ALSO enforce the same rule inside
   * `onWalletPayment`, since this is only a courtesy.
   */
  blockedReason?: string | null;
  /**
   * Settle the wallet token through the parent's normal order pipeline. Absent
   * keeps the seam inert — this component never creates an order itself.
   */
  onWalletPayment?: (payment: WalletPayment) => Promise<WalletSettleResult>;
}

type Status = 'probing' | 'unavailable' | 'ready' | 'paying';

/** The "or pay with card" rule that keeps the card section visually secondary. */
function CardDivider() {
  return (
    <div className="flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-slate-400">
      <span className="h-px flex-1 bg-slate-200" aria-hidden />
      or pay with card
      <span className="h-px flex-1 bg-slate-200" aria-hidden />
    </div>
  );
}

/**
 * The pre-integration placeholder. Kept verbatim so a checkout that has not yet
 * been handed the wallet props looks exactly as it did before.
 */
function InertSeam() {
  return (
    <div className="space-y-3" aria-label="Express checkout">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          type="button"
          disabled
          className="flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-black px-4 text-sm font-semibold text-white opacity-40"
        >
          <Apple className="h-4 w-4" aria-hidden />
          Apple&nbsp;Pay
        </button>
        <button
          type="button"
          disabled
          className="flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 opacity-40"
        >
          <Wallet className="h-4 w-4" aria-hidden />
          Google&nbsp;Pay
        </button>
      </div>
      <p className="text-center text-xs text-slate-400">
        Express wallet checkout is coming soon.
      </p>
      <CardDivider />
    </div>
  );
}

/**
 * The simulated wallet sheet, used in a sandbox run on any browser that cannot
 * run the real PaymentRequest API. It shows the same lines the real sheet would
 * and offers the outcomes a real wallet can produce: authorize, processor
 * decline, and dismissal.
 */
function SandboxSheet({
  request,
  onChoose,
}: {
  request: SandboxSheetRequest;
  onChoose: (choice: SandboxSheetChoice) => void;
}) {
  const payRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    payRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${request.label} (sandbox)`}
        className="w-full max-w-sm rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onChoose({ action: 'cancel' });
        }}
      >
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-900">{request.label}</p>
          <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-700">
            Sandbox
          </span>
        </div>

        <dl className="mt-4 space-y-1.5">
          {request.lines.map((line) => (
            <div key={line.label} className="flex items-baseline justify-between text-sm">
              <dt className="text-slate-600">{line.label}</dt>
              <dd className="text-slate-900">
                {line.amountCents < 0
                  ? `−${formatUSD(Math.abs(line.amountCents))}`
                  : formatUSD(line.amountCents)}
              </dd>
            </div>
          ))}
          <div className="!mt-3 flex items-baseline justify-between border-t border-slate-200 pt-3 text-base font-semibold">
            <dt className="text-slate-900">
              {request.totals.estimated ? 'Total (estimated)' : 'Total'}
            </dt>
            <dd className="text-slate-900">{formatUSD(request.totals.totalCents)}</dd>
          </div>
        </dl>

        <div className="mt-5 space-y-2">
          <button
            ref={payRef}
            type="button"
            onClick={() => onChoose({ action: 'pay' })}
            className="min-h-[48px] w-full rounded-xl bg-black px-4 text-sm font-semibold text-white transition hover:opacity-90"
          >
            Authorize {formatUSD(request.totals.totalCents)}
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onChoose({ action: 'decline' })}
              className="min-h-[40px] rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
            >
              Simulate decline
            </button>
            <button
              type="button"
              onClick={() => onChoose({ action: 'cancel' })}
              className="min-h-[40px] rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>

        <p className="mt-3 text-center text-xs text-slate-400">
          No real wallet or card is involved. The charge is settled by the local
          payment simulator.
        </p>
      </div>
    </div>
  );
}

export function WalletExpress({
  enabled,
  config,
  totals,
  itemLabel,
  blockedReason,
  onWalletPayment,
}: WalletExpressProps) {
  const [status, setStatus] = useState<Status>('probing');
  const [driver, setDriver] = useState<WalletDriver | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SandboxSheetRequest | null>(null);

  // The driver is created once and reads these at click time, so a quantity, tip,
  // or promo change between the probe and the tap is always reflected in the sheet.
  const totalsRef = useRef(totals);
  const itemLabelRef = useRef(itemLabel);
  const settleRef = useRef(onWalletPayment);
  totalsRef.current = totals;
  itemLabelRef.current = itemLabel;
  settleRef.current = onWalletPayment;

  // Bridges the imperative driver to the declarative sheet: the driver awaits this
  // promise, the sheet's buttons resolve it.
  const sheetResolver = useRef<((choice: SandboxSheetChoice) => void) | null>(null);
  const openSandboxSheet = useCallback(
    (request: SandboxSheetRequest) =>
      new Promise<SandboxSheetChoice>((resolve) => {
        sheetResolver.current = resolve;
        setSheet(request);
      }),
    [],
  );
  const closeSandboxSheet = useCallback((choice: SandboxSheetChoice) => {
    setSheet(null);
    const resolve = sheetResolver.current;
    sheetResolver.current = null;
    resolve?.(choice);
  }, []);

  // A pending sheet must not leave the driver awaiting forever if checkout
  // unmounts (e.g. the parent redirects) — resolve it as a dismissal.
  useEffect(
    () => () => {
      sheetResolver.current?.({ action: 'cancel' });
      sheetResolver.current = null;
    },
    [],
  );

  const payable = Boolean(
    enabled && config?.enabled && totals && totals.totalCents > 0 && onWalletPayment,
  );

  // Probe once per configuration. Deliberately keyed on primitives rather than the
  // config/totals objects, which are rebuilt on every parent render — and the probe
  // does not depend on the amount, only on whether there is one.
  const mode = config?.mode;
  const publishableKey = config?.publishableKey;
  const country = config?.country;
  const currency = config?.currency;
  const merchantName = config?.merchantName;

  useEffect(() => {
    const initialTotals = totals;
    if (!payable || !config || !initialTotals) {
      setStatus('unavailable');
      return;
    }

    let cancelled = false;
    setStatus('probing');

    createWalletDriver({
      config,
      getTotals: () => totalsRef.current ?? initialTotals,
      getItemLabel: () => itemLabelRef.current ?? merchantName ?? 'Booking',
      sandboxSheet: openSandboxSheet,
    })
      .then((next) => {
        if (cancelled) return;
        setDriver(next);
        setStatus(next ? 'ready' : 'unavailable');
      })
      .catch(() => {
        // createWalletDriver already swallows browser failures; this is the last
        // guard so a wallet can never take the checkout page down with it.
        if (cancelled) return;
        setDriver(null);
        setStatus('unavailable');
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payable, mode, publishableKey, country, currency, merchantName, openSandboxSheet]);

  const handleClick = useCallback(() => {
    if (!driver || status === 'paying' || blockedReason) return;
    const settle = settleRef.current;
    if (!settle) return;

    setError(null);
    setStatus('paying');

    // No await before pay(): every platform requires show() inside the gesture.
    driver
      .pay(settle)
      .then((outcome) => {
        if (outcome.status === 'failed') setError(outcome.error);
        // 'paid' leaves the button busy — the parent is redirecting to the
        // confirmation page, and re-enabling it would invite a second charge.
        if (outcome.status !== 'paid') setStatus('ready');
      })
      .catch(() => {
        setError('The wallet payment could not be completed. Please try a card.');
        setStatus('ready');
      });
  }, [driver, status, blockedReason]);

  if (!enabled) return null;

  // Not handed the real props yet: keep the original placeholder so the layout is
  // unchanged until the parent wires it.
  if (!config || !totals || !onWalletPayment) return <InertSeam />;

  // Probing, or this device has no wallet: render nothing at all.
  if (status === 'probing' || status === 'unavailable' || !driver) return null;

  const busy = status === 'paying';
  const blocked = Boolean(blockedReason);
  const isApple = driver.brand === 'apple';

  return (
    <div className="space-y-3" aria-label="Express checkout">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy || blocked}
        aria-busy={busy}
        aria-describedby={blocked ? 'wallet-blocked' : undefined}
        className={
          'flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ' +
          (isApple
            ? 'bg-black text-white hover:opacity-90'
            : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50')
        }
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : isApple ? (
          <Apple className="h-4 w-4" aria-hidden />
        ) : (
          <Wallet className="h-4 w-4" aria-hidden />
        )}
        {busy ? 'Completing your booking…' : driver.label}
      </button>

      {config.mode === 'sandbox' && (
        <p className="text-center text-xs text-slate-400">
          Sandbox wallet — settled by the local payment simulator, no real card.
        </p>
      )}

      {blocked && (
        <p id="wallet-blocked" className="text-center text-xs text-slate-500">
          {blockedReason}
        </p>
      )}

      {error && (
        <p role="alert" className="text-center text-xs text-red-600">
          {error}
        </p>
      )}

      <CardDivider />

      {sheet && <SandboxSheet request={sheet} onChoose={closeSandboxSheet} />}
    </div>
  );
}

export default WalletExpress;
