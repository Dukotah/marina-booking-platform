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
        code: result.promo.code,
        discountType: result.promo.discountType,
        discountValue: result.promo.discountValue,
      });
      setCode('');
    });
  }

  if (applied) {
    return (
      <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
        <span className="flex items-center gap-2 text-sm font-medium text-emerald-800">
          <CheckCircle2 className="h-4 w-4" aria-hidden />
          Promo <span className="font-semibold">{applied.code}</span> applied
        </span>
        <button
          type="button"
          onClick={onClear}
          className="rounded p-1 text-emerald-700 transition-colors hover:bg-emerald-100"
          aria-label={`Remove promo code ${applied.code}`}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="promo-code">Promo code</Label>
      <div className="flex gap-2">
        <Input
          id="promo-code"
          value={code}
          autoCapitalize="characters"
          placeholder="Enter code"
          aria-invalid={error ? true : undefined}
          className={cn('uppercase', error && 'border-red-500')}
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
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
