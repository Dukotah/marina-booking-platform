'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Flag, FlagOff } from 'lucide-react';
import { addNoteAction, setNoteBlockerAction, type PlatformResult } from '../actions';
import { formatDateTime, formatRelative } from '../../../lib/format';
import { Button } from '../../../components/ui';

export interface NoteView {
  id: string;
  author: string;
  body: string;
  isBlocker: boolean;
  createdAt: Date;
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size="md" disabled={pending}>
      {pending ? 'Adding…' : 'Add note'}
    </Button>
  );
}

/**
 * The call log. "Rang Tuesday, waiting on their photos" belongs here rather than in
 * somebody's head, and exactly one note at a time can be flagged as the thing
 * currently blocking go-live — that flag is what the client list and the header
 * banner read to say who a stalled client is waiting on.
 */
export function NotesLog({
  operatorId,
  notes,
  truncated = false,
}: {
  operatorId: string;
  notes: NoteView[];
  /** True when older notes exist beyond the loaded window — say so rather than imply this is all of it. */
  truncated?: boolean;
}) {
  const action = addNoteAction.bind(null, operatorId);
  const [state, formAction] = useFormState<PlatformResult | null, FormData>(action, null);
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const lastHandled = useRef<PlatformResult | null>(null);

  useEffect(() => {
    if (state?.ok && state !== lastHandled.current) {
      lastHandled.current = state;
      formRef.current?.reset();
      router.refresh();
    }
  }, [state, router]);

  const bodyError = state?.errors?.body;

  return (
    <div className="space-y-5">
      <form ref={formRef} action={formAction} className="space-y-3">
        <div>
          <label
            htmlFor="note-body"
            className="mb-1.5 block text-sm font-medium text-ink"
          >
            What happened?
          </label>
          <textarea
            id="note-body"
            name="body"
            rows={3}
            required
            placeholder="Called Tuesday — waiting on their dock photos before we can finish the activity pages."
            aria-invalid={bodyError ? true : undefined}
            aria-describedby={bodyError ? 'note-body-error' : undefined}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-muted shadow-sm transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus"
          />
          {bodyError && (
            <p id="note-body-error" role="alert" className="mt-1 text-xs text-rose-700">
              {bodyError}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            id="note-is-blocker"
            name="is_blocker"
            type="checkbox"
            className="h-4 w-4 rounded border-line-strong text-accent accent-accent focus:ring-2 focus:ring-focus"
          />
          <label htmlFor="note-is-blocker" className="text-sm text-ink-body">
            This is what is blocking them right now
          </label>
          <div className="ml-auto flex items-center gap-3">
            {state && !state.ok && state.message && (
              <p role="alert" className="text-sm text-rose-700">
                {state.message}
              </p>
            )}
            <Submit />
          </div>
        </div>
      </form>

      {notes.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-sm text-ink-muted">
          No notes yet. The first one is usually the kickoff call.
        </p>
      ) : (
        <>
          <ol className="space-y-3">
            {notes.map((note) => (
              <NoteRow key={note.id} operatorId={operatorId} note={note} />
            ))}
          </ol>
          {truncated && (
            <p className="text-xs text-ink-muted">
              Showing the {notes.length} most recent notes. Older ones are still stored.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function NoteRow({ operatorId, note }: { operatorId: string; note: NoteView }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggleBlocker() {
    setPending(true);
    setError(null);
    const result = await setNoteBlockerAction(operatorId, note.id, !note.isBlocker);
    setPending(false);
    if (result.ok) {
      router.refresh();
    } else {
      setError(result.message ?? 'Could not update that note.');
    }
  }

  return (
    <li
      className={`rounded-lg border p-4 ${
        note.isBlocker ? 'border-amber-200 bg-amber-50' : 'border-line bg-surface shadow-sm'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {note.isBlocker && (
            <p className="mb-1 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              Current blocker
            </p>
          )}
          <p className="whitespace-pre-wrap break-words text-sm text-ink">{note.body}</p>
          <p className="mt-1.5 text-xs text-ink-muted">
            {note.author} ·{' '}
            <time dateTime={note.createdAt.toISOString()} title={formatDateTime(note.createdAt)}>
              {formatRelative(note.createdAt)}
            </time>
          </p>
        </div>
        <button
          type="button"
          onClick={toggleBlocker}
          disabled={pending}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-ink-body shadow-sm transition-colors hover:bg-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
        >
          {note.isBlocker ? (
            <>
              <FlagOff className="h-3.5 w-3.5" aria-hidden /> Clear blocker
            </>
          ) : (
            <>
              <Flag className="h-3.5 w-3.5" aria-hidden /> Mark as blocker
            </>
          )}
          <span className="sr-only"> for the note from {formatDateTime(note.createdAt)}</span>
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-rose-700">
          {error}
        </p>
      )}
    </li>
  );
}
