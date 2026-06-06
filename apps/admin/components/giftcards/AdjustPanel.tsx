'use client';

import { useId, useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import { formatUSD } from '../../lib/format';
import { cn } from '../../lib/cn';
import {
  adjustGiftCardAction,
  type GiftCard,
  type AdjustResult,
} from '../../app/giftcards/actions';

export interface AdjustPanelProps {
  card: GiftCard;
  pending: boolean;
  onSuccess: (result: AdjustResult) => void;
  onError: (message: string) => void;
}

/**
 * Inline balance-adjustment panel (order:refund).
 *
 * Accepts a signed dollar amount: positive credits the card, negative debits it.
 * A mandatory reason field is required by the API.
 */
export function AdjustPanel({ card, onSuccess, onError }: AdjustPanelProps) {
  const [amountInput, setAmountInput] = useState('');
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();

  const amountFieldId = useId();
  const reasonFieldId = useId();

  // Parse dollar string → integer cents, apply sign.
  const absCents = Math.round(
    parseFloat(amountInput.replace(/[^0-9.]/g, '') || '0') * 100,
  );
  const deltaCents = direction === 'credit' ? absCents : -absCents;

  const amountValid = absCents > 0;
  // When debiting, cannot take the balance below zero.
  const debitValid = direction === 'credit' || absCents <= card.balanceCents;
  const reasonValid = reason.trim().length > 0;
  const canSubmit = amountValid && debitValid && reasonValid;

  function submit() {
    if (!canSubmit || pending) return;
    startTransition(async () => {
      const result = await adjustGiftCardAction(card.code, {
        deltaCents,
        reason: reason.trim(),
      });
      if (result.ok) {
        onSuccess(result as AdjustResult);
      } else {
        onError(result.error);
      }
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Current balance:{' '}
        <span className="font-medium text-slate-800">{formatUSD(card.balanceCents)}</span>
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        {/* Direction selector */}
        <div>
          <span className="block text-xs font-medium text-slate-600">Direction</span>
          <div className="mt-1 flex gap-3 text-sm">
            <label className="inline-flex items-center gap-1.5">
              <input
                type="radio"
                name="adjust-dir"
                checked={direction === 'credit'}
                onChange={() => setDirection('credit')}
                disabled={pending}
              />
              Credit (+)
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="radio"
                name="adjust-dir"
                checked={direction === 'debit'}
                onChange={() => setDirection('debit')}
                disabled={pending}
              />
              Debit (−)
            </label>
          </div>
        </div>

        {/* Amount */}
        <div>
          <label htmlFor={amountFieldId} className="block text-xs font-medium text-slate-600">
            Amount (USD)
          </label>
          <input
            id={amountFieldId}
            inputMode="decimal"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            disabled={pending}
            placeholder="0.00"
            className={cn(
              'mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200',
              amountInput && (!amountValid || !debitValid)
                ? 'border-red-300 focus:border-red-300'
                : 'border-slate-200 focus:border-slate-300',
            )}
          />
          {amountInput && !amountValid ? (
            <p className="mt-1 text-xs text-red-600">Enter a positive amount.</p>
          ) : amountInput && !debitValid ? (
            <p className="mt-1 text-xs text-red-600">
              Debit cannot exceed the current balance ({formatUSD(card.balanceCents)}).
            </p>
          ) : null}
        </div>

        {/* Reason */}
        <div>
          <label htmlFor={reasonFieldId} className="block text-xs font-medium text-slate-600">
            Reason <span className="text-red-500">*</span>
          </label>
          <input
            id={reasonFieldId}
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={pending}
            maxLength={500}
            placeholder="e.g. Courtesy adjustment"
            className={cn(
              'mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200',
              !reasonValid && reason.length > 0
                ? 'border-red-300'
                : 'border-slate-200 focus:border-slate-300',
            )}
          />
        </div>
      </div>

      {amountValid && debitValid ? (
        <p className="text-xs text-slate-500">
          New balance after adjustment:{' '}
          <span className="font-medium text-slate-800">
            {formatUSD(card.balanceCents + deltaCents)}
          </span>
        </p>
      ) : null}

      <button
        type="button"
        disabled={pending || !canSubmit}
        onClick={submit}
        className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
        Apply adjustment
        {canSubmit
          ? ` (${direction === 'credit' ? '+' : '−'}${formatUSD(absCents)})`
          : ''}
      </button>
    </div>
  );
}
