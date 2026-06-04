'use client';

import { useState, useTransition } from 'react';
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import { formatUSD } from '../../lib/format';
import {
  Field,
  TextInput,
  Select,
  CheckboxRow,
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
} from './fields';
import {
  createFee,
  updateFee,
  deleteFee,
  toggleFee,
  type FeeInput,
  type ActionResult,
} from '../../app/settings/actions';

export interface FeeRow {
  id: string;
  name: string;
  type: 'PERCENT' | 'FLAT';
  /** PERCENT => percentage; FLAT => integer cents (matches @marina/core pricing). */
  value: number;
  enabled: boolean;
  ignore_tax_exempt: boolean;
  activityId: string | null;
}

export interface ActivityOption {
  id: string;
  name: string;
}

/** Editable draft for the inline fee form (FLAT value entered in dollars). */
interface FeeDraft {
  name: string;
  type: 'PERCENT' | 'FLAT';
  value: number;
  enabled: boolean;
  ignore_tax_exempt: boolean;
  activity_id: string;
}

function emptyDraft(): FeeDraft {
  return {
    name: '',
    type: 'PERCENT',
    value: 0,
    enabled: true,
    ignore_tax_exempt: false,
    activity_id: '',
  };
}

function rowToDraft(row: FeeRow): FeeDraft {
  return {
    name: row.name,
    type: row.type,
    value: row.type === 'FLAT' ? row.value / 100 : row.value,
    enabled: row.enabled,
    ignore_tax_exempt: row.ignore_tax_exempt,
    activity_id: row.activityId ?? '',
  };
}

/** Human-readable fee amount. */
function formatFeeValue(type: 'PERCENT' | 'FLAT', value: number): string {
  return type === 'PERCENT' ? `${value}%` : formatUSD(value);
}

/**
 * Fee & tax manager. The @marina/core pricing engine treats a PERCENT fee named
 * with "Tax" as sales tax and one named with "Processing" as the processing fee;
 * all other PERCENT fees and FLAT fees apply to the taxable subtotal. This UI
 * makes that explicit so operators understand naming matters.
 */
export function FeesManager({ fees, activities }: { fees: FeeRow[]; activities: ActivityOption[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<FeeDraft>(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function beginCreate() {
    setDraft(emptyDraft());
    setEditingId(null);
    setCreating(true);
    setError(null);
  }

  function beginEdit(row: FeeRow) {
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
    const payload: FeeInput = {
      name: draft.name,
      type: draft.type,
      value: draft.value,
      enabled: draft.enabled,
      ignore_tax_exempt: draft.ignore_tax_exempt,
      activity_id: draft.activity_id,
    };
    startTransition(async () => {
      const result: ActionResult =
        editingId != null ? await updateFee(editingId, payload) : await createFee(payload);
      if (result.ok) {
        cancel();
        return;
      }
      const firstFieldError = result.errors ? Object.values(result.errors)[0] : undefined;
      setError(firstFieldError ?? result.message ?? 'Could not save fee.');
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteFee(id);
      if (!result.ok) setError(result.message ?? 'Could not delete fee.');
    });
  }

  function onToggle(id: string) {
    startTransition(async () => {
      const result = await toggleFee(id);
      if (!result.ok) setError(result.message ?? 'Could not update fee.');
    });
  }

  const activityName = (id: string | null) =>
    id ? activities.find((a) => a.id === id)?.name ?? 'Unknown activity' : 'All activities';

  return (
    <SettingsCard
      title="Fees & taxes"
      description="Name a percent fee with “Tax” for sales tax and “Processing” for the card fee — the pricing engine recognizes those. Flat fees and other percents apply to the taxable subtotal."
      footer={
        !creating && editingId == null ? (
          <PrimaryButton type="button" onClick={beginCreate} disabled={isPending}>
            <Plus className="h-4 w-4" aria-hidden /> Add fee
          </PrimaryButton>
        ) : undefined
      }
    >
      {error ? <p className="mb-3 text-sm font-medium text-rose-600">{error}</p> : null}

      {creating ? <FeeEditor draft={draft} setDraft={setDraft} activities={activities} onSave={save} onCancel={cancel} isPending={isPending} /> : null}

      {fees.length === 0 && !creating ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No fees yet. Add sales tax, a processing fee, or any custom charge.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {fees.map((row) =>
            editingId === row.id ? (
              <li key={row.id} className="py-4">
                <FeeEditor
                  draft={draft}
                  setDraft={setDraft}
                  activities={activities}
                  onSave={save}
                  onCancel={cancel}
                  isPending={isPending}
                />
              </li>
            ) : (
              <li key={row.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-900">{row.name}</span>
                    {!row.enabled ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                        Disabled
                      </span>
                    ) : null}
                    {row.ignore_tax_exempt ? (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                        Charged even if tax-exempt
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {formatFeeValue(row.type, row.value)} · {activityName(row.activityId)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onToggle(row.id)}
                    disabled={isPending}
                    className="rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
                  >
                    {row.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    onClick={() => beginEdit(row)}
                    disabled={isPending}
                    aria-label={`Edit ${row.name}`}
                    className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  >
                    <Pencil className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(row.id)}
                    disabled={isPending}
                    aria-label={`Delete ${row.name}`}
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

function FeeEditor({
  draft,
  setDraft,
  activities,
  onSave,
  onCancel,
  isPending,
}: {
  draft: FeeDraft;
  setDraft: (d: FeeDraft) => void;
  activities: ActivityOption[];
  onSave: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Fee name" required hint="Include “Tax” or “Processing” for special handling.">
          <TextInput
            value={draft.name}
            placeholder="e.g. Sales Tax"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label="Type">
          <Select
            value={draft.type}
            onChange={(e) => setDraft({ ...draft, type: e.target.value as 'PERCENT' | 'FLAT' })}
          >
            <option value="PERCENT">Percent (%)</option>
            <option value="FLAT">Flat (USD)</option>
          </Select>
        </Field>
        <Field label={draft.type === 'PERCENT' ? 'Percentage' : 'Amount (USD)'} required>
          <div className="relative">
            {draft.type === 'FLAT' ? (
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                $
              </span>
            ) : null}
            <TextInput
              type="number"
              min={0}
              step="0.01"
              className={draft.type === 'FLAT' ? 'pl-7' : ''}
              value={Number.isNaN(draft.value) ? '' : draft.value}
              onChange={(e) => setDraft({ ...draft, value: e.target.valueAsNumber })}
            />
          </div>
        </Field>
        <Field label="Applies to" hint="Limit to one activity, or apply to all.">
          <Select
            value={draft.activity_id}
            onChange={(e) => setDraft({ ...draft, activity_id: e.target.value })}
          >
            <option value="">All activities</option>
            {activities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <CheckboxRow
          label="Enabled"
          description="Apply this fee to new orders."
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
        />
        <CheckboxRow
          label="Charge even when tax-exempt"
          description="Still apply this fee to tax-exempt orders."
          checked={draft.ignore_tax_exempt}
          onChange={(e) => setDraft({ ...draft, ignore_tax_exempt: e.target.checked })}
        />
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <SecondaryButton type="button" onClick={onCancel} disabled={isPending}>
          <X className="h-4 w-4" aria-hidden /> Cancel
        </SecondaryButton>
        <PrimaryButton type="button" onClick={onSave} disabled={isPending}>
          <Check className="h-4 w-4" aria-hidden /> {isPending ? 'Saving…' : 'Save fee'}
        </PrimaryButton>
      </div>
    </div>
  );
}
