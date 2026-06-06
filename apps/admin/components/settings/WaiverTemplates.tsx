'use client';

import { useState, useTransition, useRef } from 'react';
import { FileText, CheckCircle2, Clock, AlertTriangle } from 'lucide-react';
import { cn } from '../../lib/cn';
import {
  SettingsCard,
  Field,
  TextInput,
  TextArea,
  CheckboxRow,
  PrimaryButton,
  SecondaryButton,
  SaveStatus,
  type SaveState,
} from './fields';
import { publishWaiverVersion, activateWaiverVersion } from '../../app/settings/waivers/actions';

/**
 * Client components for waiver template management.
 *
 * Three exported components:
 *  - WaiverReadOnlyNotice   — shown when the user lacks operator:manage
 *  - WaiverVersionList      — the full version history (active badge, sig count, activate button)
 *  - WaiverPublishForm      — the "publish new version" form (operator:manage only)
 *
 * Template content is IMMUTABLE per version — there is no in-place edit. Publishing
 * a new version is the only way to update legal text. Old versions are retained for
 * the signatures that reference them.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface WaiverTemplate {
  id: string;
  name: string;
  templateHtml: string;
  requiresMinorSignature: boolean;
  isActive: boolean;
  createdAt: string;
  signatureCount: number;
}

// ---------------------------------------------------------------------------
// Read-only notice
// ---------------------------------------------------------------------------

export function WaiverReadOnlyNotice() {
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
      <p className="text-sm text-amber-800">
        You have read-only access to waiver templates. Publishing new versions or changing the
        active version requires manager access.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Version list
// ---------------------------------------------------------------------------

interface VersionRowProps {
  template: WaiverTemplate;
  canManage: boolean;
  onActivate: (id: string) => void;
  activatingId: string | null;
  activateError: string | null;
}

function VersionRow({ template, canManage, onActivate, activatingId, activateError }: VersionRowProps) {
  const isActivating = activatingId === template.id;
  const createdDate = new Date(template.createdAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between',
        template.isActive
          ? 'border-emerald-200 bg-emerald-50'
          : 'border-slate-200 bg-white',
      )}
    >
      {/* Left: metadata */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          <span className="text-sm font-semibold text-slate-900 truncate">{template.name}</span>
          {template.isActive ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
              <CheckCircle2 className="h-3 w-3" aria-hidden />
              Active
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
              <Clock className="h-3 w-3" aria-hidden />
              Inactive
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500">
          <span>Published {createdDate}</span>
          <span>
            {template.signatureCount === 0
              ? 'No signatures yet'
              : `${template.signatureCount.toLocaleString()} signature${template.signatureCount === 1 ? '' : 's'} on file`}
          </span>
          {template.requiresMinorSignature && (
            <span className="text-slate-400">Requires guardian signature for minors</span>
          )}
        </div>
        {activateError && activatingId === template.id && (
          <p className="mt-1.5 text-xs font-medium text-rose-600">{activateError}</p>
        )}
      </div>

      {/* Right: action */}
      {canManage && !template.isActive && (
        <div className="shrink-0">
          <SecondaryButton
            type="button"
            disabled={activatingId !== null}
            onClick={() => onActivate(template.id)}
            className="text-xs px-3 py-1.5"
          >
            {isActivating ? 'Activating…' : 'Make active'}
          </SecondaryButton>
        </div>
      )}
    </div>
  );
}

export function WaiverVersionList({
  templates,
  canManage,
}: {
  templates: WaiverTemplate[];
  canManage: boolean;
}) {
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handleActivate(id: string) {
    setActivatingId(id);
    setActivateError(null);
    startTransition(async () => {
      const result = await activateWaiverVersion(id);
      if (!result.ok) {
        setActivateError(result.error ?? 'Could not activate version.');
      }
      setActivatingId(null);
    });
  }

  if (templates.length === 0) {
    return (
      <div className="mb-6 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center">
        <FileText className="mx-auto h-8 w-8 text-slate-300" aria-hidden />
        <p className="mt-3 text-sm font-medium text-slate-600">No waiver templates yet</p>
        <p className="mt-1 text-xs text-slate-400">
          Publish your first version below. Once published, guests will sign the active version
          at checkout.
        </p>
      </div>
    );
  }

  return (
    <SettingsCard
      title="Version history"
      description="All published versions, newest first. Signed versions are kept forever — switching the active version never alters past signatures."
    >
      <div className="space-y-3">
        {templates.map((t) => (
          <VersionRow
            key={t.id}
            template={t}
            canManage={canManage}
            onActivate={handleActivate}
            activatingId={activatingId}
            activateError={activateError}
          />
        ))}
      </div>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Publish form
// ---------------------------------------------------------------------------

interface PublishFormState {
  name: string;
  templateHtml: string;
  requiresMinorSignature: boolean;
  activate: boolean;
}

const INITIAL_FORM: PublishFormState = {
  name: '',
  templateHtml: '',
  requiresMinorSignature: true,
  activate: true,
};

export function WaiverPublishForm() {
  const [form, setForm] = useState<PublishFormState>(INITIAL_FORM);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [isPending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Partial<Record<keyof PublishFormState, string>>>({});
  const formRef = useRef<HTMLFormElement>(null);

  function validate(): boolean {
    const next: typeof errors = {};
    if (!form.name.trim()) next.name = 'Template name is required.';
    if (!form.templateHtml.trim()) next.templateHtml = 'Template HTML is required.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!validate()) return;

    setSaveState({ kind: 'idle' });
    startTransition(async () => {
      const fd = new FormData();
      fd.set('name', form.name);
      fd.set('templateHtml', form.templateHtml);
      fd.set('requiresMinorSignature', String(form.requiresMinorSignature));
      fd.set('activate', String(form.activate));

      const result = await publishWaiverVersion(fd);
      if (result.ok) {
        setSaveState({ kind: 'saved' });
        setForm(INITIAL_FORM);
        setErrors({});
      } else {
        setSaveState({ kind: 'error', message: result.error ?? 'Could not publish template.' });
      }
    });
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-6 mt-6">
      <SettingsCard
        title="Publish new version"
        description="Publishing creates a new immutable version and (by default) immediately activates it, replacing the current active version. The old version and all signatures it collected are retained permanently."
        footer={
          <>
            <SaveStatus state={saveState} savedLabel="Version published" />
            <PrimaryButton type="submit" disabled={isPending}>
              {isPending ? 'Publishing…' : 'Publish new version'}
            </PrimaryButton>
          </>
        }
      >
        <div className="space-y-4">
          {/* Immutability callout */}
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
            <p className="text-xs text-amber-800">
              Template content is <strong>locked once published</strong>. Customers sign the exact
              HTML they see — changing legal text always means publishing a new version.
            </p>
          </div>

          <Field
            label="Version name"
            htmlFor="waiver-name"
            required
            hint='e.g. "Lake Sonoma Marina Liability Waiver v2" — visible only to staff.'
            error={errors.name}
          >
            <TextInput
              id="waiver-name"
              placeholder="Liability Waiver v2"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              invalid={Boolean(errors.name)}
              disabled={isPending}
              maxLength={160}
            />
          </Field>

          <Field
            label="Template HTML"
            htmlFor="waiver-html"
            required
            hint="Full HTML of the waiver document. Customers will read this before signing. Max 200,000 characters."
            error={errors.templateHtml}
          >
            <TextArea
              id="waiver-html"
              placeholder="<h1>Liability Waiver</h1>&#10;<p>By signing below…</p>"
              value={form.templateHtml}
              onChange={(e) => setForm((f) => ({ ...f, templateHtml: e.target.value }))}
              invalid={Boolean(errors.templateHtml)}
              disabled={isPending}
              className="min-h-[200px] font-mono text-xs"
              maxLength={200_000}
            />
          </Field>

          <div className="flex flex-col gap-3 sm:flex-row">
            <CheckboxRow
              label="Require guardian signature for minors"
              description="When enabled, guests below the legal adult age must have a parent or guardian co-sign."
              checked={form.requiresMinorSignature}
              onChange={(e) =>
                setForm((f) => ({ ...f, requiresMinorSignature: e.target.checked }))
              }
              disabled={isPending}
              className="flex-1"
            />
            <CheckboxRow
              label="Activate immediately"
              description="Make this version the active one upon publishing. Uncheck to publish as inactive and activate later."
              checked={form.activate}
              onChange={(e) => setForm((f) => ({ ...f, activate: e.target.checked }))}
              disabled={isPending}
              className="flex-1"
            />
          </div>
        </div>
      </SettingsCard>
    </form>
  );
}
