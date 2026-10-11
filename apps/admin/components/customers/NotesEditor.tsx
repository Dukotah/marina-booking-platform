'use client';

import { useState, useTransition } from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../ui';
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
      <p className="whitespace-pre-wrap text-sm text-ink-body">{saved}</p>
    ) : (
      <p className="text-sm text-ink-muted">No notes.</p>
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
          'w-full resize-y rounded-lg border border-line bg-surface p-3 text-sm text-ink shadow-sm placeholder:text-ink-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus',
          isPending && 'opacity-70',
        )}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="text-xs">
          {status === 'saved' ? <span className="text-emerald-600">Saved.</span> : null}
          {status === 'error' ? <span className="text-rose-600">{error}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          {dirty ? (
            <Button
              variant="ghost"
              onClick={() => {
                setValue(saved);
                setStatus('idle');
                setError(null);
              }}
              disabled={isPending}
            >
              Cancel
            </Button>
          ) : null}
          <Button variant="primary" onClick={save} disabled={!dirty || isPending}>
            {isPending ? 'Saving…' : 'Save notes'}
          </Button>
        </div>
      </div>
    </div>
  );
}
