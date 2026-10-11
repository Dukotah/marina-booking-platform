'use client';

import { useState, useTransition } from 'react';
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import {
  Field,
  TextInput,
  TextArea,
  Select,
  CheckboxRow,
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
} from './fields';
import {
  createQuestion,
  updateQuestion,
  deleteQuestion,
  toggleQuestion,
  type QuestionInput,
  type ActionResult,
} from '../../app/settings/actions';

const TYPES: { value: QuestionInput['type']; label: string }[] = [
  { value: 'TEXT', label: 'Short text' },
  { value: 'TEXTAREA', label: 'Long text' },
  { value: 'SELECT', label: 'Choice list' },
  { value: 'CHECKBOX', label: 'Checkbox (yes/no)' },
  { value: 'NUMBER', label: 'Number' },
  { value: 'DATE', label: 'Date' },
  { value: 'PHONE', label: 'Phone' },
];

const typeLabel = (value: string) => TYPES.find((t) => t.value === value)?.label ?? value;

export interface QuestionOption {
  id: string;
  label: string;
}

export interface QuestionRow {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
  appliesTo: string | null;
  appliesToRate: string | null;
  showInConfirmation: boolean;
  isActive: boolean;
  sortIndex: number;
}

interface QuestionDraft {
  label: string;
  type: QuestionInput['type'];
  required: boolean;
  /** Raw newline-separated options text; split on save. */
  optionsText: string;
  applies_to: string;
  applies_to_rate: string;
  show_in_confirmation: boolean;
  is_active: boolean;
  sort_index: number;
}

function emptyDraft(): QuestionDraft {
  return {
    label: '',
    type: 'TEXT',
    required: false,
    optionsText: '',
    applies_to: '',
    applies_to_rate: '',
    show_in_confirmation: false,
    is_active: true,
    sort_index: 0,
  };
}

function rowToDraft(row: QuestionRow): QuestionDraft {
  return {
    label: row.label,
    type: (TYPES.find((t) => t.value === row.type)?.value ?? 'TEXT') as QuestionInput['type'],
    required: row.required,
    optionsText: row.options.join('\n'),
    applies_to: row.appliesTo ?? '',
    applies_to_rate: row.appliesToRate ?? '',
    show_in_confirmation: row.showInConfirmation,
    is_active: row.isActive,
    sort_index: row.sortIndex,
  };
}

/**
 * Customer-questions manager. Operator-defined checkout fields captured on the
 * order. Supports scoping to an activity and/or a single rate, flagging answers
 * to echo in the confirmation email, and the DATE/PHONE field types. Same inline
 * create/edit pattern as the other settings managers; Clean-SaaS teal tokens.
 */
export function QuestionsManager({
  questions,
  activities,
  rates,
}: {
  questions: QuestionRow[];
  activities: QuestionOption[];
  rates: QuestionOption[];
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<QuestionDraft>(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const activityName = (id: string | null) =>
    id ? activities.find((a) => a.id === id)?.label ?? 'Unknown activity' : 'All activities';
  const rateName = (id: string | null) =>
    id ? rates.find((r) => r.id === id)?.label ?? 'Unknown rate' : null;

  function beginCreate() {
    setDraft(emptyDraft());
    setEditingId(null);
    setCreating(true);
    setError(null);
  }

  function beginEdit(row: QuestionRow) {
    setDraft(rowToDraft(row));
    setEditingId(row.id);
    setCreating(false);
    setError(null);
  }

  function cancel() {
    setCreating(false);
    setEditingId(null);
    setError(null);
  }

  function save() {
    setError(null);
    const options =
      draft.type === 'SELECT'
        ? draft.optionsText
            .split('\n')
            .map((o) => o.trim())
            .filter(Boolean)
        : [];
    const payload: QuestionInput = {
      label: draft.label,
      type: draft.type,
      required: draft.required,
      options,
      applies_to: draft.applies_to,
      applies_to_rate: draft.applies_to_rate,
      show_in_confirmation: draft.show_in_confirmation,
      is_active: draft.is_active,
      sort_index: draft.sort_index,
    };
    startTransition(async () => {
      const result: ActionResult =
        editingId != null
          ? await updateQuestion(editingId, payload)
          : await createQuestion(payload);
      if (result.ok) {
        cancel();
        return;
      }
      const firstFieldError = result.errors ? Object.values(result.errors)[0] : undefined;
      setError(firstFieldError ?? result.message ?? 'Could not save question.');
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteQuestion(id);
      if (!result.ok) setError(result.message ?? 'Could not delete question.');
    });
  }

  function onToggle(id: string) {
    startTransition(async () => {
      const result = await toggleQuestion(id);
      if (!result.ok) setError(result.message ?? 'Could not update question.');
    });
  }

  return (
    <SettingsCard
      title="Customer questions"
      description="Ask guests for the details you need at checkout — a trailer plate, an arrival time, a phone number. Optionally scope a question to one activity or rate, and choose whether the answer is echoed back in the confirmation email."
      footer={
        !creating && editingId == null ? (
          <PrimaryButton type="button" onClick={beginCreate} disabled={isPending}>
            <Plus className="h-4 w-4" aria-hidden /> Add question
          </PrimaryButton>
        ) : undefined
      }
    >
      {error ? <p className="mb-3 text-sm font-medium text-rose-600">{error}</p> : null}

      {creating ? (
        <QuestionEditor
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          onCancel={cancel}
          isPending={isPending}
          activities={activities}
          rates={rates}
        />
      ) : null}

      {questions.length === 0 && !creating ? (
        <div className="rounded-lg border border-dashed border-line-strong bg-surface p-8 text-center text-sm text-ink-muted">
          No questions yet. Add one to collect extra details from guests at checkout.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {questions.map((row) =>
            editingId === row.id ? (
              <li key={row.id} className="py-4">
                <QuestionEditor
                  draft={draft}
                  setDraft={setDraft}
                  onSave={save}
                  onCancel={cancel}
                  isPending={isPending}
                  activities={activities}
                  rates={rates}
                />
              </li>
            ) : (
              <li key={row.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{row.label}</span>
                    {row.required ? (
                      <span className="rounded-full bg-accent-tint px-2 py-0.5 text-[11px] font-medium text-accent-ink">
                        Required
                      </span>
                    ) : null}
                    {row.showInConfirmation ? (
                      <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-body">
                        In confirmation
                      </span>
                    ) : null}
                    {!row.isActive ? (
                      <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-muted">
                        Inactive
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {typeLabel(row.type)} · {activityName(row.appliesTo)}
                    {rateName(row.appliesToRate) ? ` · ${rateName(row.appliesToRate)}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onToggle(row.id)}
                    disabled={isPending}
                    className="min-h-11 rounded-md px-2 py-1 text-xs font-medium text-ink-body hover:bg-surface-muted"
                  >
                    {row.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                  <button
                    type="button"
                    onClick={() => beginEdit(row)}
                    disabled={isPending}
                    aria-label={`Edit ${row.label}`}
                    className="rounded-md p-1.5 text-ink-muted hover:bg-surface-muted hover:text-ink-body"
                  >
                    <Pencil className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(row.id)}
                    disabled={isPending}
                    aria-label={`Delete ${row.label}`}
                    className="rounded-md p-1.5 text-rose-500 hover:bg-rose-50"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </SettingsCard>
  );
}

function QuestionEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  isPending,
  activities,
  rates,
}: {
  draft: QuestionDraft;
  setDraft: (d: QuestionDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  isPending: boolean;
  activities: QuestionOption[];
  rates: QuestionOption[];
}) {
  return (
    <div className="mb-4 rounded-lg border border-line bg-surface-muted p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Question label" required hint="Shown to the guest at checkout.">
          <TextInput
            value={draft.label}
            placeholder="e.g. Trailer license plate"
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </Field>
        <Field label="Answer type">
          <Select
            value={draft.type}
            onChange={(e) =>
              setDraft({ ...draft, type: e.target.value as QuestionInput['type'] })
            }
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {draft.type === 'SELECT' ? (
        <div className="mt-4">
          <Field label="Choices" hint="One option per line.">
            <TextArea
              rows={4}
              value={draft.optionsText}
              placeholder={'Option A\nOption B'}
              onChange={(e) => setDraft({ ...draft, optionsText: e.target.value })}
            />
          </Field>
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Applies to activity" hint="Leave as “All activities” to always ask.">
          <Select
            value={draft.applies_to}
            onChange={(e) => setDraft({ ...draft, applies_to: e.target.value })}
          >
            <option value="">All activities</option>
            {activities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Applies to rate" hint="Optional — narrow to a single rate.">
          <Select
            value={draft.applies_to_rate}
            onChange={(e) => setDraft({ ...draft, applies_to_rate: e.target.value })}
          >
            <option value="">Any rate</option>
            {rates.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-3 space-y-2">
        <CheckboxRow
          label="Required"
          description="Guests must answer before they can book."
          checked={draft.required}
          onChange={(e) => setDraft({ ...draft, required: e.target.checked })}
        />
        <CheckboxRow
          label="Show in confirmation email"
          description="Echo the guest's answer back in the booking confirmation."
          checked={draft.show_in_confirmation}
          onChange={(e) => setDraft({ ...draft, show_in_confirmation: e.target.checked })}
        />
        <CheckboxRow
          label="Active"
          description="Ask this question at checkout."
          checked={draft.is_active}
          onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })}
        />
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <SecondaryButton type="button" onClick={onCancel} disabled={isPending}>
          <X className="h-4 w-4" aria-hidden /> Cancel
        </SecondaryButton>
        <PrimaryButton type="button" onClick={onSave} disabled={isPending}>
          <Check className="h-4 w-4" aria-hidden /> {isPending ? 'Saving…' : 'Save question'}
        </PrimaryButton>
      </div>
    </div>
  );
}
