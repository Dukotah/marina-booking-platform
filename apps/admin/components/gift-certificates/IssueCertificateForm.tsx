'use client';

import { useState, useTransition } from 'react';
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
      className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      action={(formData) =>
        startTransition(async () => {
          const r = await issueGiftCertificateAction(formData);
          setResult(r.ok ? { code: r.code } : { error: r.error });
        })
      }
    >
      <label className="flex flex-col text-xs font-medium text-slate-600">
        Value (USD)
        <input
          name="valueDollars"
          type="number"
          min="1"
          step="0.01"
          required
          className="mt-1 w-28 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
        />
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-600">
        Specific activity (optional)
        <select
          name="activityId"
          className="mt-1 w-56 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
        >
          <option value="">Any — fixed dollar value</option>
          {activities.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-600">
        Recipient email (optional)
        <input
          name="recipientEmail"
          type="email"
          className="mt-1 w-56 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-60"
      >
        {pending ? 'Issuing…' : 'Issue certificate'}
      </button>

      {result?.code ? (
        <p className="w-full text-sm text-emerald-700">
          Issued <span className="font-mono font-semibold">{result.code}</span>
        </p>
      ) : null}
      {result?.error ? <p className="w-full text-sm text-red-600">{result.error}</p> : null}
    </form>
  );
}
