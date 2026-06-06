'use client';

import { useState, useTransition } from 'react';
import { Banknote, CreditCard, Gift, Loader2, CheckCircle2, User } from 'lucide-react';
import { formatUSD, toCents } from '@marina/core';
import { cn } from '../../lib/cn';
import { checkGiftCardBalance } from '../../app/pos/actions';
import type { GiftCardBalanceResult, PosPaymentMethod, SaleResult } from './types';

/**
 * Payment + checkout panel. Choose cash, card, or gift card; add an optional tip;
 * optionally attach a named customer (defaults to a walk-up guest); and complete the
 * sale. For cash the operator enters the amount tendered and we show change due. For
 * gift card the operator enters the card code and can optionally check the balance
 * before charging. The success state acts as a lightweight receipt.
 */
export interface PaymentPanelProps {
  totalCents: number;
  itemCount: number;
  method: PosPaymentMethod;
  onMethodChange: (method: PosPaymentMethod) => void;
  tipCents: number;
  onTipChange: (cents: number) => void;
  cashTenderedCents: number;
  onCashTenderedChange: (cents: number) => void;
  /** Gift card code entered by staff. */
  giftCardCode: string;
  onGiftCardCodeChange: (code: string) => void;
  /**
   * Optional partial amount to draw from the gift card, integer cents.
   * Leave 0 / undefined to draw the full order balance.
   */
  giftCardAmountCents: number;
  onGiftCardAmountChange: (cents: number) => void;
  customer: { firstName: string; lastName: string; email: string; phone: string };
  onCustomerChange: (
    customer: { firstName: string; lastName: string; email: string; phone: string },
  ) => void;
  submitting: boolean;
  result: SaleResult | null;
  onCheckout: () => void;
  onNewSale: () => void;
}

const TIP_PRESETS = [0, 10, 15, 20];

export function PaymentPanel({
  totalCents,
  itemCount,
  method,
  onMethodChange,
  tipCents,
  onTipChange,
  cashTenderedCents,
  onCashTenderedChange,
  giftCardCode,
  onGiftCardCodeChange,
  giftCardAmountCents,
  onGiftCardAmountChange,
  customer,
  onCustomerChange,
  submitting,
  result,
  onCheckout,
  onNewSale,
}: PaymentPanelProps) {
  const [showCustomer, setShowCustomer] = useState(false);
  const [balanceResult, setBalanceResult] = useState<GiftCardBalanceResult | null>(null);
  const [checkingBalance, startCheckBalance] = useTransition();

  // Success / receipt state.
  if (result?.ok) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-center">
        <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" aria-hidden />
        <div className="mt-2 text-lg font-bold text-emerald-900">Sale complete</div>
        <div className="mt-1 text-sm text-emerald-800">
          Order <span className="font-semibold">{result.orderNumber}</span>
        </div>
        <div className="mt-3 space-y-1 text-sm text-emerald-900">
          <div className="flex items-center justify-between">
            <span>Charged</span>
            <span className="font-semibold">{formatUSD(result.totalCents ?? 0)}</span>
          </div>
          {result.changeDueCents && result.changeDueCents > 0 ? (
            <div className="flex items-center justify-between text-base font-bold">
              <span>Change due</span>
              <span>{formatUSD(result.changeDueCents)}</span>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onNewSale}
          className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-lg bg-slate-900 px-5 text-sm font-semibold text-white hover:bg-slate-800"
        >
          New sale
        </button>
      </div>
    );
  }

  // Subtotal-derived tip presets operate on (total - existing tip) so toggling presets
  // recomputes against the pre-tip amount.
  const preTipTotal = totalCents - tipCents;
  const changeDue = cashTenderedCents - totalCents;

  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      {/* Payment method */}
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Payment method
        </div>
        <div className="grid grid-cols-3 gap-2">
          <MethodButton
            active={method === 'CASH'}
            onClick={() => { onMethodChange('CASH'); setBalanceResult(null); }}
            icon={<Banknote className="h-4 w-4" aria-hidden />}
            label="Cash"
          />
          <MethodButton
            active={method === 'CARD'}
            onClick={() => { onMethodChange('CARD'); setBalanceResult(null); }}
            icon={<CreditCard className="h-4 w-4" aria-hidden />}
            label="Card"
          />
          <MethodButton
            active={method === 'GIFT_CARD'}
            onClick={() => { onMethodChange('GIFT_CARD'); setBalanceResult(null); }}
            icon={<Gift className="h-4 w-4" aria-hidden />}
            label="Gift card"
          />
        </div>
      </div>

      {/* Tip */}
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Tip
        </div>
        <div className="grid grid-cols-4 gap-2">
          {TIP_PRESETS.map((pct) => {
            const cents = Math.round((preTipTotal * pct) / 100);
            const active = pct === 0 ? tipCents === 0 : tipCents === cents && cents > 0;
            return (
              <button
                key={pct}
                type="button"
                onClick={() => onTipChange(cents)}
                className={cn(
                  'h-9 rounded-lg border text-sm font-medium transition-colors',
                  active
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300',
                )}
              >
                {pct === 0 ? 'None' : `${pct}%`}
              </button>
            );
          })}
        </div>
        <div className="relative mt-2">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
            $
          </span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={tipCents ? (tipCents / 100).toString() : ''}
            onChange={(e) => {
              const v = Number.parseFloat(e.target.value);
              onTipChange(Number.isFinite(v) && v > 0 ? toCents(v) : 0);
            }}
            placeholder="Custom tip"
            aria-label="Custom tip amount"
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-7 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
          />
        </div>
      </div>

      {/* Cash tendered */}
      {method === 'CASH' ? (
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Cash tendered
          </div>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
              $
            </span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={cashTenderedCents ? (cashTenderedCents / 100).toString() : ''}
              onChange={(e) => {
                const v = Number.parseFloat(e.target.value);
                onCashTenderedChange(Number.isFinite(v) && v > 0 ? toCents(v) : 0);
              }}
              placeholder={(totalCents / 100).toFixed(2)}
              aria-label="Cash tendered"
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-7 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />
          </div>
          {cashTenderedCents > 0 ? (
            <div
              className={cn(
                'mt-1 text-right text-sm font-medium',
                changeDue >= 0 ? 'text-emerald-700' : 'text-red-600',
              )}
            >
              {changeDue >= 0
                ? `Change due ${formatUSD(changeDue)}`
                : `Short ${formatUSD(Math.abs(changeDue))}`}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Gift card entry */}
      {method === 'GIFT_CARD' ? (
        <div className="space-y-3">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Gift card
          </div>

          {/* Code input + balance check */}
          <div className="flex gap-2">
            <input
              type="text"
              value={giftCardCode}
              onChange={(e) => {
                onGiftCardCodeChange(e.target.value);
                setBalanceResult(null);
              }}
              placeholder="Gift card code"
              aria-label="Gift card code"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-mono text-slate-800 placeholder:font-sans placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />
            <button
              type="button"
              disabled={!giftCardCode.trim() || checkingBalance}
              onClick={() => {
                setBalanceResult(null);
                startCheckBalance(async () => {
                  const res = await checkGiftCardBalance(giftCardCode);
                  setBalanceResult(res);
                });
              }}
              className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checkingBalance ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                'Check balance'
              )}
            </button>
          </div>

          {/* Balance feedback */}
          {balanceResult ? (
            balanceResult.ok ? (
              <div
                className={cn(
                  'rounded-lg border px-3 py-2 text-sm',
                  !balanceResult.isActive || balanceResult.expired
                    ? 'border-amber-200 bg-amber-50 text-amber-800'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-800',
                )}
              >
                {!balanceResult.isActive ? (
                  'Card is inactive.'
                ) : balanceResult.expired ? (
                  'Card has expired.'
                ) : (
                  <>
                    Balance: <span className="font-semibold">{formatUSD(balanceResult.balanceCents ?? 0)}</span>
                    {(balanceResult.balanceCents ?? 0) < totalCents ? (
                      <span className="ml-1 text-amber-700">
                        — insufficient for {formatUSD(totalCents)}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            ) : (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {balanceResult.error}
              </p>
            )
          ) : null}

          {/* Optional partial draw amount */}
          <div>
            <div className="mb-1 text-xs text-slate-500">
              Amount to apply (leave blank to cover full balance)
            </div>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                $
              </span>
              <input
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={giftCardAmountCents ? (giftCardAmountCents / 100).toString() : ''}
                onChange={(e) => {
                  const v = Number.parseFloat(e.target.value);
                  onGiftCardAmountChange(Number.isFinite(v) && v > 0 ? toCents(v) : 0);
                }}
                placeholder={(totalCents / 100).toFixed(2)}
                aria-label="Gift card amount to apply"
                className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-7 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
              />
            </div>
          </div>
        </div>
      ) : null}

      {/* Optional customer */}
      <div>
        <button
          type="button"
          onClick={() => setShowCustomer((s) => !s)}
          className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700"
        >
          <User className="h-3.5 w-3.5" aria-hidden />
          {showCustomer ? 'Hide customer' : 'Attach customer (optional)'}
        </button>
        {showCustomer ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              type="text"
              value={customer.firstName}
              onChange={(e) => onCustomerChange({ ...customer, firstName: e.target.value })}
              placeholder="First name"
              aria-label="Customer first name"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />
            <input
              type="text"
              value={customer.lastName}
              onChange={(e) => onCustomerChange({ ...customer, lastName: e.target.value })}
              placeholder="Last name"
              aria-label="Customer last name"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />
            <input
              type="email"
              value={customer.email}
              onChange={(e) => onCustomerChange({ ...customer, email: e.target.value })}
              placeholder="Email (optional)"
              aria-label="Customer email"
              className="col-span-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />
            <input
              type="tel"
              value={customer.phone}
              onChange={(e) => onCustomerChange({ ...customer, phone: e.target.value })}
              placeholder="Phone (optional)"
              aria-label="Customer phone"
              className="col-span-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />
          </div>
        ) : null}
      </div>

      {result?.error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {result.error}
        </p>
      ) : null}

      {/* Checkout */}
      <button
        type="button"
        disabled={
          submitting ||
          itemCount === 0 ||
          totalCents <= 0 ||
          (method === 'CASH' && cashTenderedCents < totalCents) ||
          (method === 'GIFT_CARD' && !giftCardCode.trim())
        }
        onClick={onCheckout}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 text-base font-bold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : null}
        {method === 'GIFT_CARD' ? 'Apply gift card' : `Charge ${formatUSD(totalCents)}`}
      </button>
    </div>
  );
}

function MethodButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-12 items-center justify-center gap-2 rounded-lg border text-sm font-semibold transition-colors',
        active
          ? 'border-slate-900 bg-slate-900 text-white'
          : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
