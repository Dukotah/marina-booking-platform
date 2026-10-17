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
  createMessageTemplate,
  updateMessageTemplate,
  deleteMessageTemplate,
  toggleMessageTemplate,
  type MessageTemplateInput,
  type ActionResult,
} from '../../app/settings/actions';

const KINDS: { value: MessageTemplateInput['kind']; label: string; blurb: string }[] = [
  {
    value: 'BOOKING_CONFIRMATION',
    label: 'Booking confirmation',
    blurb: 'Sent right after a guest books.',
  },
  {
    value: 'BOOKING_REMINDER',
    label: 'Booking reminder',
    blurb: 'Sent ahead of the trip as a nudge.',
  },
  { value: 'REFUND_RECEIPT', label: 'Refund receipt', blurb: 'Sent when a refund is issued.' },
  {
    value: 'BOOKING_CANCELLED',
    label: 'Booking cancelled',
    blurb: 'Sent when a booking is cancelled.',
  },
  {
    value: 'REVIEW_REQUEST',
    label: 'Review request',
    blurb: 'Sent after the trip to ask for a review.',
  },
];

const kindLabel = (value: string) => KINDS.find((k) => k.value === value)?.label ?? value;

export interface MessageTemplateRow {
  id: string;
  kind: string;
  enabled: boolean;
  subjectOverride: string | null;
  bodyOverride: string | null;
  smsBodyOverride: string | null;
}

interface TemplateDraft {
  kind: MessageTemplateInput['kind'];
  enabled: boolean;
  subject_override: string;
  body_override: string;
  sms_body_override: string;
}

function emptyDraft(): TemplateDraft {
  return {
    kind: 'BOOKING_CONFIRMATION',
    enabled: true,
    subject_override: '',
    body_override: '',
    sms_body_override: '',
  };
}

function rowToDraft(row: MessageTemplateRow): TemplateDraft {
  return {
    kind: (KINDS.find((k) => k.value === row.kind)?.value ??
      'BOOKING_CONFIRMATION') as MessageTemplateInput['kind'],
    enabled: row.enabled,
    subject_override: row.subjectOverride ?? '',
    body_override: row.bodyOverride ?? '',
    sms_body_override: row.smsBodyOverride ?? '',
  };
}

/**
 * Message-template manager. Operator overrides for the transactional messages
 * (confirmation, reminder, refund receipt, cancellation, review request). Each
 * row targets one `MessageTemplateKind`; the notifications service uses the
 * override fields when present (and the template is enabled) and falls back to
 * the built-in default copy for any blank field. One override per kind. Same
 * inline create/edit pattern as the other settings managers.
 */
export function MessageTemplatesManager({ templates }: { templates: MessageTemplateRow[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<TemplateDraft>(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function beginCreate() {
    setDraft(emptyDraft());
    setEditingId(null);
    setCreating(true);
    setError(null);
  }

  function beginEdit(row: MessageTemplateRow) {
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
    const payload: MessageTemplateInput = {
      kind: draft.kind,
      enabled: draft.enabled,
      subject_override: draft.subject_override,
      body_override: draft.body_override,
      sms_body_override: draft.sms_body_override,
    };
    startTransition(async () => {
      const result: ActionResult =
        editingId != null
          ? await updateMessageTemplate(editingId, payload)
          : await createMessageTemplate(payload);
      if (result.ok) {
        cancel();
        return;
      }
      const firstFieldError = result.errors ? Object.values(result.errors)[0] : undefined;
      setError(firstFieldError ?? result.message ?? 'Could not save template.');
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteMessageTemplate(id);
      if (!result.ok) setError(result.message ?? 'Could not delete template.');
    });
  }

  function onToggle(id: string) {
    startTransition(async () => {
      const result = await toggleMessageTemplate(id);
      if (!result.ok) setError(result.message ?? 'Could not update template.');
    });
  }

  return (
    <SettingsCard
      title="Message templates"
      description="Override the copy for the automatic guest messages — confirmation, reminder, refund receipt, cancellation, and review request. Leave a field blank to keep the built-in default. Use {{placeholders}} like {{guest_name}} and {{order_number}}; the SMS body is a shorter, subject-less version."
      footer={
        !creating && editingId == null ? (
          <PrimaryButton type="button" onClick={beginCreate} disabled={isPending}>
            <Plus className="h-4 w-4" aria-hidden /> Add template
          </PrimaryButton>
        ) : undefined
      }
    >
      {error ? <p className="mb-3 text-sm font-medium text-rose-600">{error}</p> : null}

      {creating ? (
        <TemplateEditor
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          onCancel={cancel}
          isPending={isPending}
        />
      ) : null}

      {templates.length === 0 && !creating ? (
        <div className="rounded-lg border border-dashed border-line-strong bg-surface p-8 text-center text-sm text-ink-muted">
          No overrides yet. Every message uses the built-in default copy until you add one.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {templates.map((row) =>
            editingId === row.id ? (
              <li key={row.id} className="py-4">
                <TemplateEditor
                  draft={draft}
                  setDraft={setDraft}
                  onSave={save}
                  onCancel={cancel}
                  isPending={isPending}
                />
              </li>
            ) : (
              <li key={row.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">
                      {kindLabel(row.kind)}
                    </span>
                    {row.smsBodyOverride ? (
                      <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-body">
                        SMS override
                      </span>
                    ) : null}
                    {!row.enabled ? (
                      <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-muted">
                        Disabled
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink-muted">
                    {row.subjectOverride
                      ? row.subjectOverride
                      : 'Default subject · overriding body only'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onToggle(row.id)}
                    disabled={isPending}
                    className="min-h-11 rounded-md px-2 py-1 text-xs font-medium text-ink-body hover:bg-surface-muted"
                  >
                    {row.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    onClick={() => beginEdit(row)}
                    disabled={isPending}
                    aria-label={`Edit ${kindLabel(row.kind)}`}
                    className="rounded-md p-1.5 text-ink-muted hover:bg-surface-muted hover:text-ink-body"
                  >
                    <Pencil className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(row.id)}
                    disabled={isPending}
                    aria-label={`Delete ${kindLabel(row.kind)}`}
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

function TemplateEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  isPending,
}: {
  draft: TemplateDraft;
  setDraft: (d: TemplateDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const hint = KINDS.find((k) => k.value === draft.kind)?.blurb;
  return (
    <div className="mb-4 rounded-lg border border-line bg-surface-muted p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Message" hint={hint}>
          <Select
            value={draft.kind}
            onChange={(e) =>
              setDraft({ ...draft, kind: e.target.value as MessageTemplateInput['kind'] })
            }
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Subject" hint="Email subject line. Leave blank to keep the default.">
          <TextInput
            value={draft.subject_override}
            placeholder="e.g. Your booking is confirmed"
            onChange={(e) => setDraft({ ...draft, subject_override: e.target.value })}
          />
        </Field>
      </div>

      <div className="mt-4">
        <Field label="Email body" hint="Supports {{placeholders}}. Leave blank to keep the default copy.">
          <TextArea
            rows={6}
            value={draft.body_override}
            placeholder={'Hi {{guest_name}},\n\nThanks for booking {{order_number}}…'}
            onChange={(e) => setDraft({ ...draft, body_override: e.target.value })}
          />
        </Field>
      </div>

      <div className="mt-4">
        <Field label="SMS body" hint="Shorter, subject-less text. Leave blank to keep the compact default.">
          <TextArea
            rows={3}
            value={draft.sms_body_override}
            placeholder={'Booking {{order_number}} confirmed — see your email for details.'}
            onChange={(e) => setDraft({ ...draft, sms_body_override: e.target.value })}
          />
        </Field>
      </div>

      <div className="mt-3 space-y-2">
        <CheckboxRow
          label="Enabled"
          description="Use this override. When off, the message falls back to the built-in default copy."
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
        />
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <SecondaryButton type="button" onClick={onCancel} disabled={isPending}>
          <X className="h-4 w-4" aria-hidden /> Cancel
        </SecondaryButton>
        <PrimaryButton type="button" onClick={onSave} disabled={isPending}>
          <Check className="h-4 w-4" aria-hidden /> {isPending ? 'Saving…' : 'Save template'}
        </PrimaryButton>
      </div>
    </div>
  );
}
