'use client';

/**
 * Promo code field. Validation is delegated to the server action `checkPromo`
 * (which calls the tenant-scoped API), so codes are checked against the real,
 * operator-owned promo records — never trusted from the client. On success the
 * applied promo is lifted to the parent, which feeds the live price breakdown.
 */
import { useState, useTransition } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { Button, Input, Label, cn } from '@marina/ui';
import { checkPromo } from '@/app/checkout/actions';
import type { AppliedPromo } from './types';

interface PromoFieldProps {
  activityId: string;
  applied: AppliedPromo | null;
  onApply: (promo: AppliedPromo) => void;
  onClear: () => void;
}

export function PromoField({ activityId, applied, onApply, onClear }: PromoFieldProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Enter a promo code.');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await checkPromo(trimmed, activityId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (!result.promo.valid) {
        setError(result.promo.reason ?? 'That promo code is not valid.');
        return;
      }
      onApply({
        // `POST /api/promos/validate` does not echo the code back (only the demo
        // driver does), so trusting `result.promo.code` renders "Promo undefined
        // applied" and — because the same value is what checkout submits — sends
        // `promoCode: undefined` with the order, so the discount the guest was
        // shown is never actually taken off the charge. The code the guest typed
        // is the reliable one; uppercase because that is how the rest of the
        // system normalizes a code (the booking service uppercases before lookup).
        code: result.promo.code ?? trimmed.toUpperCase(),
        discountType: result.promo.discountType,
        discountValue: result.promo.discountValue,
      });
      setCode('');
    });
  }

  return (
    <div>
      {/*
        The live region is mounted in both states, empty until a code lands. A
        region that appears at the same instant as its own text is announced
        unreliably — assistive tech has to already be watching the element for a
        change to it to count — so the confirmation is swapped into a wrapper that
        was always here. Without this, applying a code moves focus nowhere and
        says nothing: a guest who cannot see the chip has no idea it worked.
      */}
      <div role="status" aria-live="polite">
        {applied && (
          <div className="flex items-center justify-between rounded-lg border border-hairline bg-bg px-3 py-2">
            <span className="flex items-center gap-2 text-sm font-medium text-success">
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Promo <span className="font-semibold">{applied.code}</span> applied
            </span>
            <button
              type="button"
              onClick={onClear}
              className="rounded p-1 text-success transition-colors hover:bg-surface"
              aria-label={`Remove promo code ${applied.code}`}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        )}
      </div>

      {!applied && (
        <div className="space-y-1.5">
          <Label htmlFor="promo-code">Promo code</Label>
          <div className="flex gap-2">
            <Input
              id="promo-code"
              value={code}
              autoCapitalize="characters"
              placeholder="Enter code"
              aria-invalid={error ? true : undefined}
              className={cn('uppercase rounded-lg border-hairline bg-surface text-ink placeholder:text-muted', error && 'border-danger')}
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
