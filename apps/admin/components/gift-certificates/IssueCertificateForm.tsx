'use client';

import { useState, useTransition } from 'react';
import { Button, Input, Select, FieldLabel } from '../ui';
import { issueGiftCertificateAction } from '../../app/gift-certificates/actions';

export interface ActivityOption {
  id: string;
  name: string;
}

/**
 * Compact issue form for a single-use gift certificate. Submits to the
 * `issueGiftCertificateAction` server action and shows the freshly minted code so
 * staff can hand/email it to the purchaser.
 */
export function IssueCertificateForm({ activities }: { activities: ActivityOption[] }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ code?: string; error?: string } | null>(null);

  return (
    <form
      className="flex flex-wrap items-end gap-4 rounded-lg border border-line bg-surface p-5 shadow-sm"
      action={(formData) =>
        startTransition(async () => {
          const r = await issueGiftCertificateAction(formData);
          setResult(r.ok ? { code: r.code } : { error: r.error });
        })
      }
    >
      <div>
        <FieldLabel htmlFor="gc-value">Value (USD)</FieldLabel>
        <Input id="gc-value" name="valueDollars" type="number" min="1" step="0.01" required className="w-32" />
      </div>
      <div>
        <FieldLabel htmlFor="gc-activity">Specific activity (optional)</FieldLabel>
        <Select id="gc-activity" name="activityId" className="w-60">
          <option value="">Any — fixed dollar value</option>
          {activities.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <FieldLabel htmlFor="gc-recipient">Recipient email (optional)</FieldLabel>
        <Input id="gc-recipient" name="recipientEmail" type="email" className="w-60" />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Issuing…' : 'Issue certificate'}
      </Button>

      <div aria-live="polite" className="w-full">
        {result?.code ? (
          <p className="text-sm text-emerald-700">
            Issued <span className="font-mono font-semibold">{result.code}</span>
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
