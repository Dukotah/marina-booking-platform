'use client';

/**
 * Gift card field. The balance check is delegated to the server action
 * `checkGiftCardBalance` (which calls the tenant-scoped API), so the card is
 * verified against real, operator-owned stored value — never trusted from the
 * client. On success the applied card (code + previewed balance) is lifted to the
 * parent, which feeds the live price breakdown and the card-required gating.
 *
 * The balance shown here is a PREVIEW only: the authoritative draw-down happens
 * server-side at redeem time (after the order exists), so a stale balance can
 * never become money. See `placeOrder` in app/checkout/actions.ts.
 */
import { useState, useTransition } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { Button, Input, Label, cn } from '@marina/ui';
import { formatUSD } from '@marina/core';
import { checkGiftCardBalance } from '@/app/checkout/actions';
import type { AppliedGiftCard } from './types';

interface GiftCardFieldProps {
  applied: AppliedGiftCard | null;
  onApply: (giftCard: AppliedGiftCard) => void;
  onClear: () => void;
}

export function GiftCardField({ applied, onApply, onClear }: GiftCardFieldProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Enter a gift card code.');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await checkGiftCardBalance(trimmed);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (!result.giftCard.valid) {
        setError(result.giftCard.reason ?? 'That gift card cannot be used.');
        return;
      }
      if (result.giftCard.balanceCents <= 0) {
        setError('This gift card has no remaining balance.');
        return;
      }
      onApply({
        // Use the code the API echoes back (already normalized) when present, else
        // the typed code uppercased — matching how the redeem service normalizes
        // before lookup, so the code we submit resolves to the same card.
        code: result.giftCard.code || trimmed.toUpperCase(),
        availableCents: result.giftCard.balanceCents,
      });
      setCode('');
    });
  }

  return (
    <div>
      {/*
        The live region is mounted in both states, empty until a card lands — a
        region that appears at the same instant as its own text is announced
        unreliably, so the confirmation is swapped into a wrapper that was always
        here. Mirrors PromoField so an applied card is announced to a guest who
        cannot see the chip.
      */}
      <div role="status" aria-live="polite">
        {applied && (
          <div className="flex items-center justify-between rounded-lg border border-hairline bg-bg px-3 py-2">
            <span className="flex items-center gap-2 text-sm font-medium text-success">
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Gift card <span className="font-semibold">{applied.code}</span> applied
              <span className="text-muted">
                ({formatUSD(applied.availableCents)} available)
              </span>
            </span>
            <button
              type="button"
              onClick={onClear}
              className="rounded p-1 text-success transition-colors hover:bg-surface"
              aria-label={`Remove gift card ${applied.code}`}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        )}
      </div>

      {!applied && (
        <div className="space-y-1.5">
          <Label htmlFor="gift-card-code">Gift card</Label>
          <div className="flex gap-2">
            <Input
              id="gift-card-code"
              value={code}
              autoCapitalize="characters"
              placeholder="Enter code"
              aria-invalid={error ? true : undefined}
              className={cn(
                'uppercase rounded-lg border-hairline bg-surface text-ink placeholder:text-muted',
                error && 'border-danger',
              )}
              onChange={(e) => {
                setCode(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              loading={pending}
              onClick={submit}
              disabled={!code.trim()}
            >
              Apply
            </Button>
          </div>
          {/* A rejected code is as silent as an accepted one was; `role="alert"`
              matches how the checkout form announces its own field errors. */}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
