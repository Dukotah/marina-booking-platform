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
  createChargePreset,
  updateChargePreset,
  deleteChargePreset,
  toggleChargePreset,
  type ChargePresetInput,
  type ActionResult,
} from '../../app/settings/actions';

/** Mirrors OrderCharge.category / addOrderChargeAction's accepted set. */
const CATEGORIES: { value: ChargePresetInput['category']; label: string }[] = [
  { value: 'FUEL', label: 'Fuel' },
  { value: 'CLEANING', label: 'Cleaning' },
  { value: 'DAMAGE', label: 'Damage' },
  { value: 'LATE', label: 'Late return' },
  { value: 'OTHER', label: 'Other' },
];

const categoryLabel = (value: string) =>
  CATEGORIES.find((c) => c.value === value)?.label ?? value;

export interface ChargePresetRow {
  id: string;
  label: string;
  category: string;
  /** Integer cents. */
  amountCents: number;
  active: boolean;
}

/** Editable draft (amount entered in dollars). */
interface PresetDraft {
  label: string;
  category: ChargePresetInput['category'];
  amount_dollars: number;
  active: boolean;
}

function emptyDraft(): PresetDraft {
  return { label: '', category: 'FUEL', amount_dollars: 0, active: true };
}

function rowToDraft(row: ChargePresetRow): PresetDraft {
  return {
    label: row.label,
    category: (CATEGORIES.find((c) => c.value === row.category)?.value ?? 'OTHER'),
    amount_dollars: row.amountCents / 100,
    active: row.active,
  };
}

/**
 * Charge-preset manager. Presets are reusable one-click charges (fuel, cleaning,
 * damage, late) that pre-fill the "Add fuel / charge" flow on the order + manifest.
 * Same inline create/edit pattern as the Fees manager.
 */
export function ChargePresetsManager({ presets }: { presets: ChargePresetRow[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<PresetDraft>(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function beginCreate() {
    setDraft(emptyDraft());
    setEditingId(null);
    setCreating(true);
    setError(null);
  }

  function beginEdit(row: ChargePresetRow) {
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
    const payload: ChargePresetInput = {
      label: draft.label,
      category: draft.category,
      amount_dollars: draft.amount_dollars,
      active: draft.active,
    };
    startTransition(async () => {
      const result: ActionResult =
        editingId != null
          ? await updateChargePreset(editingId, payload)
          : await createChargePreset(payload);
      if (result.ok) {
        cancel();
        return;
      }
      const firstFieldError = result.errors ? Object.values(result.errors)[0] : undefined;
      setError(firstFieldError ?? result.message ?? 'Could not save preset.');
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteChargePreset(id);
      if (!result.ok) setError(result.message ?? 'Could not delete preset.');
    });
  }

  function onToggle(id: string) {
    startTransition(async () => {
      const result = await toggleChargePreset(id);
      if (!result.ok) setError(result.message ?? 'Could not update preset.');
    });
  }

  return (
    <SettingsCard
      title="Charge presets"
      description="Save the charges you add again and again — a half tank of fuel, a standard cleaning fee. Staff pick one when a boat returns and the category, label and amount fill in (still editable)."
      footer={
        !creating && editingId == null ? (
          <PrimaryButton type="button" onClick={beginCreate} disabled={isPending}>
            <Plus className="h-4 w-4" aria-hidden /> Add preset
          </PrimaryButton>
        ) : undefined
      }
    >
      {error ? <p className="mb-3 text-sm font-medium text-rose-600">{error}</p> : null}

      {creating ? (
        <PresetEditor
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          onCancel={cancel}
          isPending={isPending}
        />
      ) : null}

      {presets.length === 0 && !creating ? (
        <div className="rounded-lg border border-dashed border-line-strong bg-surface p-8 text-center text-sm text-ink-muted">
          No presets yet. Add a fuel, cleaning or damage charge you use often.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {presets.map((row) =>
            editingId === row.id ? (
              <li key={row.id} className="py-4">
                <PresetEditor
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
                    <span className="truncate text-sm font-medium text-ink">{row.label}</span>
                    {!row.active ? (
                      <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-muted">
                        Inactive
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {formatUSD(row.amountCents)} · {categoryLabel(row.category)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onToggle(row.id)}
                    disabled={isPending}
                    className="rounded-md px-2 py-1 text-xs font-medium text-ink-body hover:bg-surface-muted"
                  >
                    {row.active ? 'Deactivate' : 'Activate'}
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

function PresetEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  isPending,
}: {
  draft: PresetDraft;
  setDraft: (d: PresetDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  return (
    <div className="mb-4 rounded-lg border border-line bg-surface-muted p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Label" required hint="Shown on the receipt, e.g. “Fuel — half tank”.">
          <TextInput
            value={draft.label}
            placeholder="e.g. Fuel — half tank"
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </Field>
        <Field label="Category">
          <Select
            value={draft.category}
            onChange={(e) =>
              setDraft({ ...draft, category: e.target.value as ChargePresetInput['category'] })
            }
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount (USD)" required>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-muted">
              $
            </span>
            <TextInput
              type="number"
              min={0}
              step="0.01"
              className="pl-7"
              value={Number.isNaN(draft.amount_dollars) ? '' : draft.amount_dollars}
              onChange={(e) => setDraft({ ...draft, amount_dollars: e.target.valueAsNumber })}
            />
          </div>
        </Field>
      </div>

      <div className="mt-3">
        <CheckboxRow
          label="Active"
          description="Show this preset in the “Add charge” picker."
          checked={draft.active}
          onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
        />
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <SecondaryButton type="button" onClick={onCancel} disabled={isPending}>
          <X className="h-4 w-4" aria-hidden /> Cancel
        </SecondaryButton>
        <PrimaryButton type="button" onClick={onSave} disabled={isPending}>
          <Check className="h-4 w-4" aria-hidden /> {isPending ? 'Saving…' : 'Save preset'}
        </PrimaryButton>
      </div>
    </div>
  );
}
