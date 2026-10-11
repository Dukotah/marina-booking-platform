'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowDown,
  ArrowUp,
  Eye,
  FileSignature,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  CheckboxRow,
  Field,
  PrimaryButton,
  SaveStatus,
  SecondaryButton,
  SettingsCard,
  TextArea,
  TextInput,
  type SaveState,
} from './fields';
import {
  addClauseAction,
  createWaiverAction,
  deleteClauseAction,
  moveClauseAction,
  updateClauseAction,
  updateWaiverAction,
  type ClauseInput,
} from '../../app/settings/waivers/actions';

export interface WaiverClauseData {
  id: string;
  title: string;
  bodyHtml: string;
  requiresInitials: boolean;
  isRequired: boolean;
}

export interface WaiverData {
  id: string;
  name: string;
  version: number;
  introHtml: string;
  requiresMinorSignature: boolean;
  signatureCount: number;
  clauses: WaiverClauseData[];
}

/**
 * The operator waiver editor: waiver name + intro, clause CRUD with reordering,
 * and a live preview that mirrors the customer signer's rendering (numbered
 * clauses, per-clause initials boxes). Every text edit bumps the waiver version
 * on the server — the banner explains that past signatures keep the exact text
 * they were given, because their stored snapshot IS the legal record.
 *
 * Clause bodies are plain HTML paragraphs in a textarea — the same
 * operator-authored, trusted-HTML contract the customer signer and the packet
 * printer already render with dangerouslySetInnerHTML. No rich-text dependency.
 */
export function WaiverEditor({ waiver }: { waiver: WaiverData | null }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);

  if (!waiver) {
    return (
      <SettingsCard
        title="No waiver yet"
        description="Create your liability waiver, then add the clauses guests must acknowledge."
      >
        <PrimaryButton
          type="button"
          disabled={creating}
          onClick={() => {
            setCreating(true);
            startTransition(async () => {
              await createWaiverAction();
              router.refresh();
              setCreating(false);
            });
          }}
        >
          <FileSignature className="h-4 w-4" aria-hidden />
          {creating || isPending ? 'Creating…' : 'Create waiver'}
        </PrimaryButton>
      </SettingsCard>
    );
  }

  return <EditorLoaded waiver={waiver} />;
}

function EditorLoaded({ waiver }: { waiver: WaiverData }) {
  const router = useRouter();
  const [showPreview, setShowPreview] = useState(false);

  // Waiver meta form state.
  const [name, setName] = useState(waiver.name);
  const [introHtml, setIntroHtml] = useState(waiver.introHtml);
  const [requiresMinor, setRequiresMinor] = useState(waiver.requiresMinorSignature);
  const [metaState, setMetaState] = useState<SaveState>({ kind: 'idle' });
  const [metaPending, startMeta] = useTransition();

  // Clause list state.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listPending, startList] = useTransition();

  function saveMeta() {
    setMetaState({ kind: 'idle' });
    startMeta(async () => {
      const result = await updateWaiverAction(waiver.id, {
        name,
        introHtml,
        requiresMinorSignature: requiresMinor,
      });
      if (result.ok) {
        setMetaState({ kind: 'saved' });
        router.refresh();
      } else {
        setMetaState({
          kind: 'error',
          message:
            result.message ?? Object.values(result.errors ?? {})[0] ?? 'Could not save the waiver.',
        });
      }
    });
  }

  function runListAction(fn: () => Promise<{ ok: boolean; message?: string; errors?: Record<string, string> }>) {
    setListError(null);
    startList(async () => {
      const result = await fn();
      if (!result.ok) {
        setListError(
          result.message ?? Object.values(result.errors ?? {})[0] ?? 'Could not update the clause.',
        );
        return;
      }
      setEditingId(null);
      setAdding(false);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {/* The versioning contract, stated where edits happen. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-muted px-4 py-3 text-sm text-ink-body">
        <p>
          <span className="font-semibold">Version {waiver.version}.</span> Any text change
          creates a new version for future signers.{' '}
          {waiver.signatureCount > 0
            ? `The ${waiver.signatureCount} existing signature${
                waiver.signatureCount === 1 ? '' : 's'
              } keep the exact text they agreed to — signed records are never rewritten.`
            : 'Signed records always keep the exact text they agreed to.'}
        </p>
        <SecondaryButton type="button" onClick={() => setShowPreview((v) => !v)}>
          <Eye className="h-4 w-4" aria-hidden />
          {showPreview ? 'Hide preview' : 'Preview as signer'}
        </SecondaryButton>
      </div>

      {showPreview ? <SignerPreview waiver={{ ...waiver, name, introHtml }} /> : null}

      <SettingsCard
        title="Waiver"
        description="The document title and the preamble shown above the clauses."
        footer={
          <>
            <SaveStatus state={metaState} />
            <PrimaryButton type="button" onClick={saveMeta} disabled={metaPending}>
              {metaPending ? 'Saving…' : 'Save waiver'}
            </PrimaryButton>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Waiver name" htmlFor="waiver-name" required>
            <TextInput
              id="waiver-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
            />
          </Field>
          <Field
            label="Introduction"
            htmlFor="waiver-intro"
            hint="Shown above the clause list. Plain text or simple HTML paragraphs (<p>…</p>)."
          >
            <TextArea
              id="waiver-intro"
              value={introHtml}
              onChange={(e) => setIntroHtml(e.target.value)}
              rows={4}
            />
          </Field>
          <CheckboxRow
            label="Minors require a parent or guardian signature"
            description="When the signer's date of birth is under 18, the signer must provide a guardian name."
            checked={requiresMinor}
            onChange={(e) => setRequiresMinor(e.target.checked)}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Clauses"
        description="Each clause is shown in order with its own initials box. Required clauses block signing until acknowledged."
      >
        {listError ? (
          <p role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
            {listError}
          </p>
        ) : null}

        {waiver.clauses.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No clauses yet — add the sections guests must read and initial.
          </p>
        ) : (
          <ol className="space-y-3">
            {waiver.clauses.map((clause, index) =>
              editingId === clause.id ? (
                <li key={clause.id} className="rounded-lg border border-line-strong bg-surface-muted p-4">
                  <ClauseForm
                    initial={clause}
                    pending={listPending}
                    submitLabel="Save clause"
                    onCancel={() => setEditingId(null)}
                    onSubmit={(input) => runListAction(() => updateClauseAction(clause.id, input))}
                  />
                </li>
              ) : (
                <li
                  key={clause.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-line p-4"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">
                      {index + 1}. {clause.title}
                    </p>
                    <p className="mt-1 line-clamp-2 text-xs text-ink-muted">
                      {stripTags(clause.bodyHtml)}
                    </p>
                    <p className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                      <span className={badge(clause.isRequired)}>
                        {clause.isRequired ? 'Required' : 'Optional'}
                      </span>
                      <span className={badge(clause.requiresInitials)}>
                        {clause.requiresInitials ? 'Initials required' : 'No initials'}
                      </span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <IconButton
                      label={`Move "${clause.title}" up`}
                      disabled={listPending || index === 0}
                      onClick={() => runListAction(() => moveClauseAction(clause.id, 'up'))}
                    >
                      <ArrowUp className="h-4 w-4" aria-hidden />
                    </IconButton>
                    <IconButton
                      label={`Move "${clause.title}" down`}
                      disabled={listPending || index === waiver.clauses.length - 1}
                      onClick={() => runListAction(() => moveClauseAction(clause.id, 'down'))}
                    >
                      <ArrowDown className="h-4 w-4" aria-hidden />
                    </IconButton>
                    <IconButton
                      label={`Edit "${clause.title}"`}
                      disabled={listPending}
                      onClick={() => {
                        setAdding(false);
                        setEditingId(clause.id);
                      }}
                    >
                      <Pencil className="h-4 w-4" aria-hidden />
                    </IconButton>
                    <IconButton
                      label={`Delete "${clause.title}"`}
                      disabled={listPending}
                      danger
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete the clause "${clause.title}"? Future signers will no longer see it (existing signatures are unaffected).`,
                          )
                        ) {
                          runListAction(() => deleteClauseAction(clause.id));
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </IconButton>
                  </div>
                </li>
              ),
            )}
          </ol>
        )}

        <div className="mt-4">
          {adding ? (
            <div className="rounded-lg border border-line-strong bg-surface-muted p-4">
              <ClauseForm
                pending={listPending}
                submitLabel="Add clause"
                onCancel={() => setAdding(false)}
                onSubmit={(input) => runListAction(() => addClauseAction(waiver.id, input))}
              />
            </div>
          ) : (
            <SecondaryButton
              type="button"
              onClick={() => {
                setEditingId(null);
                setAdding(true);
              }}
            >
              <Plus className="h-4 w-4" aria-hidden /> Add clause
            </SecondaryButton>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}

function badge(active: boolean): string {
  return active
    ? 'rounded-full bg-accent-tint px-2 py-0.5 font-medium text-accent-ink'
    : 'rounded-full bg-surface-muted px-2 py-0.5 font-medium text-ink-body';
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function IconButton({
  label,
  danger,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? 'border-rose-200 text-rose-600 hover:bg-rose-50'
          : 'border-line text-ink-body hover:bg-surface-muted'
      }`}
      {...props}
    >
      {children}
    </button>
  );
}

/** Shared add/edit clause form. */
function ClauseForm({
  initial,
  pending,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: WaiverClauseData;
  pending: boolean;
  submitLabel: string;
  onSubmit: (input: ClauseInput) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [bodyHtml, setBodyHtml] = useState(initial?.bodyHtml ?? '');
  const [requiresInitials, setRequiresInitials] = useState(initial?.requiresInitials ?? true);
  const [isRequired, setIsRequired] = useState(initial?.isRequired ?? true);
  const valid = title.trim().length > 0 && bodyHtml.trim().length > 0;

  return (
    <div className="space-y-4">
      <Field label="Clause title" htmlFor={`clause-title-${initial?.id ?? 'new'}`} required>
        <TextInput
          id={`clause-title-${initial?.id ?? 'new'}`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          placeholder="e.g. Assumption of Risk"
        />
      </Field>
      <Field
        label="Clause text"
        htmlFor={`clause-body-${initial?.id ?? 'new'}`}
        required
        hint="Plain text or simple HTML paragraphs (<p>…</p>) — rendered exactly as the signer sees it."
      >
        <TextArea
          id={`clause-body-${initial?.id ?? 'new'}`}
          value={bodyHtml}
          onChange={(e) => setBodyHtml(e.target.value)}
          rows={5}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <CheckboxRow
          label="Required"
          description="Signer cannot submit without acknowledging this clause."
          checked={isRequired}
          onChange={(e) => setIsRequired(e.target.checked)}
        />
        <CheckboxRow
          label="Initials required"
          description="Signer must type their initials next to this clause."
          checked={requiresInitials}
          onChange={(e) => setRequiresInitials(e.target.checked)}
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <SecondaryButton type="button" onClick={onCancel} disabled={pending}>
          <X className="h-4 w-4" aria-hidden /> Cancel
        </SecondaryButton>
        <PrimaryButton
          type="button"
          disabled={pending || !valid}
          onClick={() => onSubmit({ title: title.trim(), bodyHtml: bodyHtml.trim(), requiresInitials, isRequired })}
        >
          {pending ? 'Saving…' : submitLabel}
        </PrimaryButton>
      </div>
    </div>
  );
}

/**
 * Live preview mirroring the customer signer (apps/web WaiverSigner): intro,
 * numbered clauses with disabled initials boxes, and the signature block. The
 * clause HTML is operator-authored trusted content — the same contract the
 * signer and packet printer use.
 */
function SignerPreview({ waiver }: { waiver: WaiverData }) {
  return (
    <section
      aria-label="Waiver preview, as the customer signer renders it"
      className="rounded-lg border-2 border-dashed border-line-strong bg-surface p-5 sm:p-6"
    >
      <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-ink-muted">
        Preview — what the signer sees
      </p>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <FileSignature className="h-5 w-5 text-teal-700" aria-hidden />
        {waiver.name}
      </h2>
      {waiver.introHtml.trim() ? (
        <div
          className="prose prose-sm mt-3 max-w-none text-ink-body"
          // Operator-authored copy — same trust model as the customer signer.
          dangerouslySetInnerHTML={{ __html: waiver.introHtml }}
        />
      ) : null}
      <ol className="mt-4 space-y-4">
        {waiver.clauses.map((clause, index) => (
          <li key={clause.id} className="rounded-lg border border-line bg-surface p-4">
            <h3 className="mb-2 text-sm font-semibold text-ink">
              {index + 1}. {clause.title}
              {!clause.isRequired ? (
                <span className="ml-2 text-xs font-normal text-ink-muted">(optional)</span>
              ) : null}
            </h3>
            <div
              className="prose prose-sm max-w-none text-ink-body"
              dangerouslySetInnerHTML={{ __html: clause.bodyHtml }}
            />
            {clause.requiresInitials ? (
              <div className="mt-3 flex items-center gap-3">
                <span className="text-xs font-medium text-ink-body">
                  Initials{clause.isRequired ? '' : ' (optional)'}
                </span>
                <span
                  aria-hidden
                  className="inline-block h-9 w-24 rounded-md border border-line-strong bg-surface-muted"
                />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="mt-5 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-ink-body">Signature (typed full legal name)</p>
          <span aria-hidden className="mt-1 inline-block h-9 w-full rounded-md border border-line-strong bg-surface-muted" />
        </div>
        <div>
          <p className="text-xs font-medium text-ink-body">Date of birth</p>
          <span aria-hidden className="mt-1 inline-block h-9 w-full rounded-md border border-line-strong bg-surface-muted" />
        </div>
      </div>
    </section>
  );
}
