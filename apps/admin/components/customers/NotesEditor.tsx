'use client';

import { useState, useTransition } from 'react';
import { cn } from '../../lib/cn';
import { updateCustomerNotes, type ActionResult } from '../../app/customers/[id]/actions';

export interface NotesEditorProps {
  customerId: string;
  initialNotes: string;
  /** When false, notes render read-only (no customer:write permission). */
  canEdit: boolean;
}

const MAX_NOTES_LENGTH = 5000;

/**
 * Free-text notes editor for the customer profile. Persists through the
 * customer:write server action. Save is enabled only when the text differs from
 * the last saved value; success/error feedback is shown inline.
 */
export function NotesEditor({ customerId, initialNotes, canEdit }: NotesEditorProps) {
  const [saved, setSaved] = useState(initialNotes);
  const [value, setValue] = useState(initialNotes);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const dirty = value.trim() !== saved.trim();

  function save() {
    if (!dirty || isPending) return;
    setStatus('idle');
    setError(null);
    startTransition(async () => {
      const result: ActionResult = await updateCustomerNotes(customerId, value);
      if (result.ok) {
        setSaved(value);
        setStatus('saved');
      } else {
        setStatus('error');
        setError(result.error ?? 'Failed to save notes.');
      }
    });
  }

  if (!canEdit) {
    return saved.trim() ? (
      <p className="whitespace-pre-wrap text-sm text-slate-700">{saved}</p>
    ) : (
      <p className="text-sm text-slate-400">No notes.</p>
    );
  }

  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (status !== 'idle') setStatus('idle');
        }}
        maxLength={MAX_NOTES_LENGTH}
        rows={5}
        disabled={isPending}
        placeholder="Add internal notes about this customer…"
        aria-label="Customer notes"
        className={cn(
          'w-full resize-y rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200',
          isPending && 'opacity-70',
        )}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="text-xs">
          {status === 'saved' ? <span className="text-emerald-600">Saved.</span> : null}
          {status === 'error' ? <span className="text-red-600">{error}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          {dirty ? (
            <button
              type="button"
              onClick={() => {
                setValue(saved);
                setStatus('idle');
                setError(null);
              }}
              disabled={isPending}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
            >
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || isPending}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? 'Saving…' : 'Save notes'}
          </button>
        </div>
      </div>
    </div>
  );
}
