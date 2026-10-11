'use client';

import { useState, useTransition } from 'react';
import { Button, Input, FieldLabel } from '../ui';
import { issueGiftCardAction } from '../../app/catalog/gift-cards/actions';

/**
 * Compact issue form for a stored-value gift card. Submits to
 * `issueGiftCardAction` and shows the freshly minted code so staff can hand or
 * email it to the purchaser. Balance starts equal to the loaded value;
 * redemption draws it down at checkout/POS.
 */
export function IssueGiftCardForm() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ code?: string; error?: string } | null>(null);

  return (
    <form
      className="flex flex-wrap items-end gap-4 rounded-lg border border-line bg-surface p-5 shadow-sm"
      action={(formData) =>
        startTransition(async () => {
          const r = await issueGiftCardAction(formData);
          setResult(r.ok ? { code: r.code } : { error: r.error });
        })
      }
    >
      <div>
        <FieldLabel htmlFor="card-value">Load amount (USD)</FieldLabel>
        <Input
          id="card-value"
          name="valueDollars"
          type="number"
          min="1"
          step="0.01"
          required
          className="w-32"
        />
      </div>
      <div>
        <FieldLabel htmlFor="card-recipient">Recipient email (optional)</FieldLabel>
        <Input id="card-recipient" name="recipientEmail" type="email" className="w-60" />
      </div>
      <div>
        <FieldLabel htmlFor="card-expires">Expires (optional)</FieldLabel>
        <Input id="card-expires" name="expiresAt" type="date" className="w-44" />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Issuing…' : 'Issue gift card'}
      </Button>

      <div aria-live="polite" className="w-full">
        {result?.code ? (
          <p className="text-sm text-emerald-700">
            Issued <span className="font-mono font-semibold">{result.code}</span> — hand or email
            this code to the purchaser.
          </p>
        ) : null}
        {result?.error ? (
          <p role="alert" className="text-sm text-rose-700">
            {result.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
