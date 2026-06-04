'use client';

import { useState, useTransition } from 'react';
import { Check } from 'lucide-react';
import { Field, TextInput, PrimaryButton, SaveStatus, type SaveState } from './fields';
import { cn } from '../../lib/cn';
import type { IntegrationDef } from './integrationCatalog';
import { upsertIntegration, type ActionResult } from '../../app/settings/actions';

export interface IntegrationState {
  enabled: boolean;
  config: Record<string, string>;
}

/**
 * A single integration card. Saves through the upsert-by-key server action so the
 * Integration record is created on first save and updated thereafter. Secret
 * fields are masked; values are sent as-is (the action stores them in the config
 * JSON, scoped to this operator by RLS).
 */
export function IntegrationCard({
  def,
  initial,
}: {
  def: IntegrationDef;
  initial: IntegrationState;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [config, setConfig] = useState<Record<string, string>>(initial.config);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [isPending, startTransition] = useTransition();

  function setField(name: string, value: string) {
    setConfig((prev) => ({ ...prev, [name]: value }));
  }

  function save() {
    setSaveState({ kind: 'idle' });
    // Only persist the fields this integration declares (drop stray keys).
    const cleanConfig: Record<string, string> = {};
    for (const field of def.fields) {
      cleanConfig[field.name] = (config[field.name] ?? '').trim();
    }
    startTransition(async () => {
      const result: ActionResult = await upsertIntegration({
        key: def.key,
        enabled,
        config: cleanConfig,
      });
      setSaveState(
        result.ok
          ? { kind: 'saved' }
          : { kind: 'error', message: result.message ?? 'Could not save integration.' },
      );
    });
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900">{def.name}</h3>
            {enabled ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                <Check className="h-3 w-3" aria-hidden /> Enabled
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-sm text-slate-500">{def.description}</p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2">
          <span className="sr-only">Enable {def.name}</span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-400"
          />
        </label>
      </div>

      <div className={cn('space-y-4 px-5 py-5', !enabled && 'opacity-60')}>
        <div className="grid gap-4 sm:grid-cols-2">
          {def.fields.map((field) => (
            <Field key={field.name} label={field.label} hint={field.hint}>
              <TextInput
                type={field.secret ? 'password' : 'text'}
                autoComplete="off"
                placeholder={field.placeholder}
                value={config[field.name] ?? ''}
                onChange={(e) => setField(field.name, e.target.value)}
              />
            </Field>
          ))}
        </div>

        <div className="flex items-center justify-end gap-3">
          <SaveStatus state={saveState} />
          <PrimaryButton type="button" onClick={save} disabled={isPending}>
            {isPending ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </div>
      </div>
    </section>
  );
}
