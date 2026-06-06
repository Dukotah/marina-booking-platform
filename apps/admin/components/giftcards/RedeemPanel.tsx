'use client';

import { useId, useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import { formatUSD } from '../../lib/format';
import { cn } from '../../lib/cn';
import {
  redeemGiftCardAction,
  type GiftCard,
  type RedeemResult,
} from '../../app/giftcards/actions';

export interface RedeemPanelProps {
  card: GiftCard;
  pending: boolean;
  onSuccess: (result: RedeemResult) => void;
  onError: (message: string) => void;
}

/**
 * Inline redeem panel: enter an amount in dollars (converted to cents server-side),
 * optional order-id note, then calls redeemGiftCardAction.
 */
export function RedeemPanel({ card, onSuccess, onError }: RedeemPanelProps) {
  const [amountInput, setAmountInput] = useState('');
  const [orderId, setOrderId] = useState('');
  const [note, setNote] = useState('');
  const [pending, startTransition] = useTransition();

  const amountFieldId = useId();
  const orderFieldId = useId();
  const noteFieldId = useId();

  // Parse dollar string → integer cents (never floats stored anywhere).
  const parsedCents = Math.round(
    parseFloat(amountInput.replace(/[^0-9.]/g, '') || '0') * 100,
  );
  const amountValid = parsedCents > 0 && parsedCents <= card.balanceCents;

  function submit() {
    if (!amountValid || pending) return;
    startTransition(async () => {
      const result = await redeemGiftCardAction(card.code, {
        amountCents: parsedCents,
        orderId: orderId.trim() || undefined,
        note: note.trim() || undefined,
      });
      if (result.ok) {
        onSuccess(result as RedeemResult);
      } else {
        onError(result.error);
      }
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Available balance:{' '}
        <span className="font-medium text-slate-800">{formatUSD(card.balanceCents)}</span>
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
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
              amountInput && !amountValid
                ? 'border-red-300 focus:border-red-300'
                : 'border-slate-200 focus:border-slate-300',
            )}
          />
          {amountInput && !amountValid ? (
            <p className="mt-1 text-xs text-red-600">
              Enter an amount from $0.01 to {formatUSD(card.balanceCents)}.
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor={orderFieldId} className="block text-xs font-medium text-slate-600">
            Order ID <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input
            id={orderFieldId}
            type="text"
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            disabled={pending}
            placeholder="e.g. ORD-00042"
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
          />
        </div>

        <div>
          <label htmlFor={noteFieldId} className="block text-xs font-medium text-slate-600">
            Note <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input
            id={noteFieldId}
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pending}
            maxLength={500}
            placeholder="e.g. Counter redemption"
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
          />
        </div>
      </div>

      <button
        type="button"
        disabled={pending || !amountValid}
        onClick={submit}
        className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
        Redeem {amountValid ? formatUSD(parsedCents) : ''}
      </button>
    </div>
  );
}
