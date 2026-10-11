'use client';

import { useState, useTransition } from 'react';
import { Banknote, CreditCard, Gift, Loader2, CheckCircle2, User, X } from 'lucide-react';
import { formatUSD, toCents } from '@marina/core';
import { cn } from '../../lib/cn';
import { Button, Card, Input } from '../ui';
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
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-center">
        <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" aria-hidden />
        <div className="mt-2 text-lg font-bold text-emerald-900">Sale complete</div>
        <div className="mt-1 text-sm text-emerald-800">
          Order <span className="font-semibold">{result.orderNumber}</span>
        </div>
        <div className="mt-3 space-y-1 text-sm text-emerald-900">
          <div className="flex items-center justify-between">
            <span>Charged</span>
            <span className="font-semibold tabular-nums">{formatUSD(result.totalCents ?? 0)}</span>
          </div>
          {result.giftCardAppliedCents && result.giftCardAppliedCents > 0 ? (
            <>
              <div className="flex items-center justify-between">
                <span>Gift card applied</span>
                <span className="font-semibold tabular-nums">
                  −{formatUSD(result.giftCardAppliedCents)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs text-emerald-800">
                <span>Gift card balance remaining</span>
                <span className="tabular-nums">{formatUSD(result.giftCardRemainingCents ?? 0)}</span>
              </div>
            </>
          ) : null}
          {result.changeDueCents && result.changeDueCents > 0 ? (
            <div className="flex items-center justify-between text-base font-bold">
              <span>Change due</span>
              <span className="tabular-nums">{formatUSD(result.changeDueCents)}</span>
            </div>
          ) : null}
        </div>
        <Button type="button" onClick={onNewSale} className="mt-4 w-full">
          New sale
        </Button>
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
    <Card className="space-y-4 p-4">
      {/* Payment method — for the remainder after any gift card is applied. */}
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
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
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Gift card
        </div>
        {giftCard ? (
          <div className="flex items-center justify-between rounded-lg border border-accent bg-accent-tint px-3 py-2">
            <div className="flex items-center gap-2 text-sm text-accent-ink">
              <Gift className="h-4 w-4 text-accent" aria-hidden />
              <div>
                <div className="font-semibold tracking-wide">{giftCard.code}</div>
                <div className="text-xs text-accent-ink tabular-nums">
                  Balance {formatUSD(giftCard.balanceCents)} · applying{' '}
                  {formatUSD(giftCardAppliedCents)}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={removeGiftCard}
              aria-label="Remove gift card"
              className="flex h-11 w-11 items-center justify-center rounded-lg text-accent hover:bg-accent-tint"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-2">
              <Input
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
                className="uppercase tracking-wide placeholder:normal-case placeholder:tracking-normal"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={checkGiftCard}
                disabled={gcChecking || gcCode.trim().length === 0}
              >
                {gcChecking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Check
              </Button>
            </div>
            {gcError ? (
              <p className="mt-1 text-sm font-medium text-rose-600">{gcError}</p>
            ) : null}
          </div>
        )}
      </div>

      {/* Tip */}
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
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
                  'h-11 rounded-lg border text-sm font-semibold transition-colors',
                  active
                    ? 'border-accent bg-accent-tint text-accent-ink'
                    : 'border-line bg-surface text-ink-body hover:border-line-strong',
                )}
              >
                {pct === 0 ? 'None' : `${pct}%`}
              </button>
            );
          })}
        </div>
        <div className="relative mt-2">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-muted">
            $
          </span>
          <Input
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
            className="pl-7 tabular-nums"
          />
        </div>
      </div>

      {/* Cash tendered (for the remainder after any gift card) */}
      {method === 'CASH' && !giftCardCoversAll ? (
        <div>
          <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-ink-muted">
            <span>Cash tendered</span>
            {giftCard ? <span className="text-ink-muted tabular-nums">Due {formatUSD(remainderCents)}</span> : null}
          </div>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-muted">
              $
            </span>
            <Input
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
              className="pl-7 tabular-nums"
            />
          </div>
          {cashTenderedCents > 0 ? (
            <div
              className={cn(
                'mt-1 text-right text-sm font-medium tabular-nums',
                changeDue >= 0 ? 'text-emerald-700' : 'text-rose-600',
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
          className="flex min-h-11 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-muted hover:text-ink-body"
        >
          <User className="h-3.5 w-3.5" aria-hidden />
          {showCustomer ? 'Hide customer' : 'Attach customer (optional)'}
        </button>
        {showCustomer ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Input
              type="text"
              value={customer.firstName}
              onChange={(e) => onCustomerChange({ ...customer, firstName: e.target.value })}
              placeholder="First name"
              aria-label="Customer first name"
            />
            <Input
              type="text"
              value={customer.lastName}
              onChange={(e) => onCustomerChange({ ...customer, lastName: e.target.value })}
              placeholder="Last name"
              aria-label="Customer last name"
            />
            <Input
              type="email"
              value={customer.email}
              onChange={(e) => onCustomerChange({ ...customer, email: e.target.value })}
              placeholder="Email (optional)"
              aria-label="Customer email"
              className="col-span-2"
            />
            <Input
              type="tel"
              value={customer.phone}
              onChange={(e) => onCustomerChange({ ...customer, phone: e.target.value })}
              placeholder="Phone (optional)"
              aria-label="Customer phone"
              className="col-span-2"
            />
          </div>
        ) : null}
      </div>

      {result?.error ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {result.error}
        </p>
      ) : null}

      {/* Checkout — the one obvious primary action on this screen. */}
      <Button
        type="button"
        size="lg"
        disabled={submitting || itemCount === 0 || totalCents <= 0 || cashShort}
        onClick={onCheckout}
        className="w-full font-bold tabular-nums"
      >
        {submitting ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : null}
        {giftCardCoversAll
          ? `Redeem ${formatUSD(giftCardAppliedCents)} gift card`
          : giftCard
            ? `Charge ${formatUSD(remainderCents)} + gift card`
            : `Charge ${formatUSD(totalCents)}`}
      </Button>
    </Card>
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
          ? 'border-accent bg-accent-tint text-accent-ink'
          : 'border-line bg-surface text-ink-body hover:border-line-strong',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
