'use client';

import { useState, useTransition, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Badge } from './Badge';
import { updateCustomerTags, type ActionResult } from '../../app/customers/[id]/actions';

export interface TagInputProps {
  customerId: string;
  initialTags: string[];
  /** When false, tags render read-only (no customer:write permission). */
  canEdit: boolean;
}

const MAX_TAG_LENGTH = 40;

/**
 * Tag editor for the customer profile. Adds tags on Enter/comma, removes via the
 * pill's close button, and persists the full set through the customer:write
 * server action. Optimistic local state is reverted if the action fails.
 */
export function TagInput({ customerId, initialTags, canEdit }: TagInputProps) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function persist(next: string[]) {
    const previous = tags;
    setTags(next);
    setError(null);
    startTransition(async () => {
      const result: ActionResult = await updateCustomerTags(customerId, next);
      if (!result.ok) {
        setTags(previous);
        setError(result.error ?? 'Failed to save tags.');
      }
    });
  }

  function addTag(raw: string) {
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH);
    if (!tag) return;
    if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      setDraft('');
      return;
    }
    persist([...tags, tag]);
    setDraft('');
  }

  function removeTag(tag: string) {
    persist(tags.filter((t) => t !== tag));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(draft);
    } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      removeTag(tags[tags.length - 1]!);
    }
  }

  if (!canEdit) {
    return tags.length ? (
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <Badge key={tag}>{tag}</Badge>
        ))}
      </div>
    ) : (
      <p className="text-sm text-slate-400">No tags.</p>
    );
  }

  return (
    <div>
      <div
        className={cn(
          'flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 bg-white p-2 focus-within:border-slate-300 focus-within:ring-2 focus-within:ring-slate-200',
          isPending && 'opacity-70',
        )}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2.5 pr-1 text-xs font-medium text-slate-700"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              disabled={isPending}
              aria-label={`Remove tag ${tag}`}
              className="rounded-full p-0.5 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => addTag(draft)}
          disabled={isPending}
          placeholder={tags.length ? 'Add tag…' : 'Add a tag (Enter to confirm)'}
          aria-label="Add tag"
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none"
        />
      </div>
      {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
