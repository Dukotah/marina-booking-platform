'use client';

import { useState, useTransition } from 'react';
import { Banknote, CreditCard, Gift, Loader2, CheckCircle2, User, X } from 'lucide-react';
import { formatUSD, toCents } from '@marina/core';
import { cn } from '../../lib/cn';
import { checkGiftCardCode } from '../../app/pos/actions';
import type { PosPaymentMethod, SaleResult } from './types';

/**
 * Payment + checkout panel. Choose cash or card, add an optional tip, optionally
 * attach a named customer (defaults to a walk-up guest), and complete the sale. For
 * cash, the operator enters the amount tendered and we show change due. The success
 * state acts as a lightweight receipt with the order number.
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
  giftCard: { code: string; balanceCents: number } | null;
  onGiftCardChange: (card: { code: string; balanceCents: number } | null) => void;
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
  giftCard,
  onGiftCardChange,
  customer,
  onCustomerChange,
  submitting,
  result,
  onCheckout,
  onNewSale,
}: PaymentPanelProps) {
  const [showCustomer, setShowCustomer] = useState(false);
  const [gcCode, setGcCode] = useState('');
  const [gcError, setGcError] = useState<string | null>(null);
  const [gcChecking, startGcCheck] = useTransition();

  function checkGiftCard() {
    const code = gcCode.trim();
    if (!code) return;
    setGcError(null);
    startGcCheck(async () => {
      const res = await checkGiftCardCode(code);
      if (res.valid) {
        onGiftCardChange({ code: res.code, balanceCents: res.balanceCents });
        setGcCode('');
      } else {
        onGiftCardChange(null);
        setGcError(res.reason ?? 'This gift card cannot be used.');
      }
    });
  }

  function removeGiftCard() {
    onGiftCardChange(null);
    setGcError(null);
    setGcCode('');
  }

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
          {result.giftCardAppliedCents && result.giftCardAppliedCents > 0 ? (
            <>
              <div className="flex items-center justify-between">
                <span>Gift card applied</span>
                <span className="font-semibold">
                  −{formatUSD(result.giftCardAppliedCents)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs text-emerald-800">
                <span>Gift card balance remaining</span>
                <span>{formatUSD(result.giftCardRemainingCents ?? 0)}</span>
              </div>
            </>
          ) : null}
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

  // A gift card covers up to the full total; the remainder is settled by cash/card.
  const giftCardAppliedCents = giftCard ? Math.min(giftCard.balanceCents, totalCents) : 0;
  const remainderCents = totalCents - giftCardAppliedCents;
  const giftCardCoversAll = giftCard != null && remainderCents === 0;
  const changeDue = cashTenderedCents - remainderCents;
  // When the card covers everything, no cash/card tender is needed to check out.
  const cashShort = method === 'CASH' && !giftCardCoversAll && cashTenderedCents < remainderCents;

  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      {/* Payment method — for the remainder after any gift card is applied. */}
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {giftCard ? 'Pay remainder with' : 'Payment method'}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <MethodButton
            active={method === 'CASH'}
            onClick={() => onMethodChange('CASH')}
            icon={<Banknote className="h-4 w-4" aria-hidden />}
            label="Cash"
            disabled={giftCardCoversAll}
          />
          <MethodButton
            active={method === 'CARD'}
            onClick={() => onMethodChange('CARD')}
            icon={<CreditCard className="h-4 w-4" aria-hidden />}
            label="Card"
            disabled={giftCardCoversAll}
          />
        </div>
      </div>

      {/* Gift card tender */}
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Gift card
        </div>
        {giftCard ? (
          <div className="flex items-center justify-between rounded-lg border border-violet-200 bg-violet-50 px-3 py-2">
            <div className="flex items-center gap-2 text-sm text-violet-900">
              <Gift className="h-4 w-4 text-violet-600" aria-hidden />
              <div>
                <div className="font-semibold tracking-wide">{giftCard.code}</div>
                <div className="text-xs text-violet-700">
                  Balance {formatUSD(giftCard.balanceCents)} · applying{' '}
                  {formatUSD(giftCardAppliedCents)}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={removeGiftCard}
              aria-label="Remove gift card"
              className="rounded-md p-1 text-violet-600 hover:bg-violet-100"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={gcCode}
                onChange={(e) => setGcCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    checkGiftCard();
                  }
                }}
                placeholder="Gift card code"
                aria-label="Gift card code"
                autoComplete="off"
                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm uppercase tracking-wide text-slate-700 placeholder:normal-case placeholder:tracking-normal placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
              />
              <button
                type="button"
                onClick={checkGiftCard}
                disabled={gcChecking || gcCode.trim().length === 0}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {gcChecking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Check
              </button>
            </div>
            {gcError ? (
              <p className="mt-1 text-sm font-medium text-red-600">{gcError}</p>
            ) : null}
          </div>
        )}
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

      {/* Cash tendered (for the remainder after any gift card) */}
      {method === 'CASH' && !giftCardCoversAll ? (
        <div>
          <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
            <span>Cash tendered</span>
            {giftCard ? <span className="text-slate-400">Due {formatUSD(remainderCents)}</span> : null}
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
              placeholder={(remainderCents / 100).toFixed(2)}
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
        disabled={submitting || itemCount === 0 || totalCents <= 0 || cashShort}
        onClick={onCheckout}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 text-base font-bold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : null}
        {giftCardCoversAll
          ? `Redeem ${formatUSD(giftCardAppliedCents)} gift card`
          : giftCard
            ? `Charge ${formatUSD(remainderCents)} + gift card`
            : `Charge ${formatUSD(totalCents)}`}
      </button>
    </div>
  );
}

function MethodButton({
  active,
  onClick,
  icon,
  label,
  disabled = false,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex h-12 items-center justify-center gap-2 rounded-lg border text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40',
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
