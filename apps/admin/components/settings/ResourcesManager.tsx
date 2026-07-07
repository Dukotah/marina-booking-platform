'use client';

import { useState, useTransition } from 'react';
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import {
  Field,
  TextInput,
  CheckboxRow,
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
} from './fields';
import {
  createResource,
  updateResource,
  deleteResource,
  type ResourceInput,
  type ActionResult,
} from '../../app/settings/resources/actions';

export interface ResourceRow {
  id: string;
  name: string;
  quantity: number;
  seatCapacity: number;
  outOfServiceQty: number;
  isActive: boolean;
  activityIds: string[];
}

export interface ActivityOption {
  id: string;
  name: string;
}

interface ResourceDraft {
  name: string;
  quantity: number;
  seat_capacity: number;
  out_of_service_qty: number;
  is_active: boolean;
  activity_ids: string[];
}

function emptyDraft(): ResourceDraft {
  return { name: '', quantity: 1, seat_capacity: 1, out_of_service_qty: 0, is_active: true, activity_ids: [] };
}

function rowToDraft(row: ResourceRow): ResourceDraft {
  return {
    name: row.name,
    quantity: row.quantity,
    seat_capacity: row.seatCapacity,
    out_of_service_qty: row.outOfServiceQty,
    is_active: row.isActive,
    activity_ids: [...row.activityIds],
  };
}

/** Bookable seats a pool provides = (units − out of service) × seats each. */
function poolSeats(d: { quantity: number; seat_capacity: number; out_of_service_qty: number }): number {
  return Math.max(0, d.quantity - d.out_of_service_qty) * d.seat_capacity;
}

/**
 * Shared-resource pools (D-014). A pool is a fleet of interchangeable units; the
 * activities you link share its capacity, so booking one draws it down for the
 * others at overlapping times — the cross-activity blocking that beats FareHarbor.
 */
export function ResourcesManager({
  resources,
  activities,
}: {
  resources: ResourceRow[];
  activities: ActivityOption[];
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<ResourceDraft>(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function beginCreate() {
    setDraft(emptyDraft());
    setEditingId(null);
    setCreating(true);
    setError(null);
  }
  function beginEdit(row: ResourceRow) {
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
    const payload: ResourceInput = { ...draft };
    startTransition(async () => {
      const result: ActionResult =
        editingId != null ? await updateResource(editingId, payload) : await createResource(payload);
      if (result.ok) {
        cancel();
        return;
      }
      const firstFieldError = result.errors ? Object.values(result.errors)[0] : undefined;
      setError(firstFieldError ?? result.message ?? 'Could not save resource.');
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteResource(id);
      if (!result.ok) setError(result.message ?? 'Could not delete resource.');
    });
  }

  const activityNames = (ids: string[]) =>
    ids.length === 0
      ? 'No activities yet'
      : ids
          .map((id) => activities.find((a) => a.id === id)?.name ?? 'Unknown')
          .join(', ');

  return (
    <SettingsCard
      title="Shared resources"
      description="Model your physical inventory as pools (a fleet of jet skis, pontoons, or guides). Link the activities that share each pool — the booking engine then stops the same unit being sold twice across them at overlapping times."
      footer={
        !creating && editingId == null ? (
          <PrimaryButton type="button" onClick={beginCreate} disabled={isPending}>
            <Plus className="h-4 w-4" aria-hidden /> Add resource
          </PrimaryButton>
        ) : undefined
      }
    >
      {error ? <p className="mb-3 text-sm font-medium text-rose-600">{error}</p> : null}

      {creating ? (
        <ResourceEditor
          draft={draft}
          setDraft={setDraft}
          activities={activities}
          onSave={save}
          onCancel={cancel}
          isPending={isPending}
        />
      ) : null}

      {resources.length === 0 && !creating ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No resources yet. Add a fleet of boats, jet skis, or guides that your activities share.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {resources.map((row) =>
            editingId === row.id ? (
              <li key={row.id} className="py-4">
                <ResourceEditor
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
                    {!row.isActive ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                        Inactive
                      </span>
                    ) : null}
                    <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
                      {poolSeats(rowToDraft(row))} seats
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {row.quantity} × {row.seatCapacity} seats
                    {row.outOfServiceQty > 0 ? ` (${row.outOfServiceQty} out of service)` : ''} ·{' '}
                    {activityNames(row.activityIds)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
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

function ResourceEditor({
  draft,
  setDraft,
  activities,
  onSave,
  onCancel,
  isPending,
}: {
  draft: ResourceDraft;
  setDraft: (d: ResourceDraft) => void;
  activities: ActivityOption[];
  onSave: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  function toggleActivity(id: string, on: boolean) {
    const set = new Set(draft.activity_ids);
    if (on) set.add(id);
    else set.delete(id);
    setDraft({ ...draft, activity_ids: [...set] });
  }

  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Resource name" required hint="e.g. Pontoon Fleet, Jet Skis, Guides">
          <TextInput
            value={draft.name}
            placeholder="e.g. Pontoon Fleet"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label="Total units" required hint="How many interchangeable units in the pool.">
          <TextInput
            type="number"
            min={1}
            step="1"
            value={Number.isNaN(draft.quantity) ? '' : draft.quantity}
            onChange={(e) => setDraft({ ...draft, quantity: e.target.valueAsNumber })}
          />
        </Field>
        <Field label="Seats per unit" required hint="Guests each unit holds (a whole-boat rental = its max party).">
          <TextInput
            type="number"
            min={1}
            step="1"
            value={Number.isNaN(draft.seat_capacity) ? '' : draft.seat_capacity}
            onChange={(e) => setDraft({ ...draft, seat_capacity: e.target.valueAsNumber })}
          />
        </Field>
        <Field label="Out of service" hint="Units temporarily unavailable (maintenance).">
          <TextInput
            type="number"
            min={0}
            step="1"
            value={Number.isNaN(draft.out_of_service_qty) ? '' : draft.out_of_service_qty}
            onChange={(e) => setDraft({ ...draft, out_of_service_qty: e.target.valueAsNumber })}
          />
        </Field>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Bookable capacity: <span className="font-semibold text-slate-700">{poolSeats(draft)} seats</span> across
        all linked activities at any overlapping time.
      </p>

      <div className="mt-4">
        <p className="mb-1.5 text-sm font-medium text-slate-700">Activities that share this pool</p>
        {activities.length === 0 ? (
          <p className="text-xs text-slate-500">No activities yet — create some first.</p>
        ) : (
          <div className="grid max-h-56 gap-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 sm:grid-cols-2">
            {activities.map((a) => (
              <label
                key={a.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300"
                  checked={draft.activity_ids.includes(a.id)}
                  onChange={(e) => toggleActivity(a.id, e.target.checked)}
                />
                <span className="truncate">{a.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3">
        <CheckboxRow
          label="Active"
          description="Enforce this pool's capacity on new bookings."
          checked={draft.is_active}
          onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })}
        />
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <SecondaryButton type="button" onClick={onCancel} disabled={isPending}>
          <X className="h-4 w-4" aria-hidden /> Cancel
        </SecondaryButton>
        <PrimaryButton type="button" onClick={onSave} disabled={isPending}>
          <Check className="h-4 w-4" aria-hidden /> {isPending ? 'Saving…' : 'Save resource'}
        </PrimaryButton>
      </div>
    </div>
  );
}
