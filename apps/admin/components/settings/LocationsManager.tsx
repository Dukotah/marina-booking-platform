'use client';

import { useState, useTransition } from 'react';
import { Plus, Pencil, Trash2, Check, X, MapPin } from 'lucide-react';
import {
  Field,
  TextInput,
  CheckboxRow,
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
} from './fields';
import {
  createLocation,
  updateLocation,
  deleteLocation,
  type LocationInput,
  type ActionResult,
} from '../../app/settings/actions';

export interface LocationRow {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  timezone: string | null;
  isDefault: boolean;
  isActive: boolean;
}

interface LocationDraft {
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  timezone: string;
  is_default: boolean;
  is_active: boolean;
}

function emptyDraft(): LocationDraft {
  return {
    name: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    timezone: '',
    is_default: false,
    is_active: true,
  };
}

function rowToDraft(row: LocationRow): LocationDraft {
  return {
    name: row.name,
    address: row.address ?? '',
    city: row.city ?? '',
    state: row.state ?? '',
    zip: row.zip ?? '',
    timezone: row.timezone ?? '',
    is_default: row.isDefault,
    is_active: row.isActive,
  };
}

function oneLineAddress(row: LocationRow): string {
  const parts = [row.address, [row.city, row.state].filter(Boolean).join(', '), row.zip].filter(
    Boolean,
  );
  return parts.length ? parts.join(' · ') : 'No address';
}

/**
 * Locations manager. Operators with one site have a single default location;
 * chains add more. Exactly one location is the default at a time (enforced
 * server-side). Deleting is blocked when activities/resources reference the site.
 */
export function LocationsManager({ locations }: { locations: LocationRow[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<LocationDraft>(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function beginCreate() {
    setDraft(emptyDraft());
    setEditingId(null);
    setCreating(true);
    setError(null);
  }

  function beginEdit(row: LocationRow) {
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
    const payload: LocationInput = { ...draft };
    startTransition(async () => {
      const result: ActionResult =
        editingId != null ? await updateLocation(editingId, payload) : await createLocation(payload);
      if (result.ok) {
        cancel();
        return;
      }
      const firstFieldError = result.errors ? Object.values(result.errors)[0] : undefined;
      setError(firstFieldError ?? result.message ?? 'Could not save location.');
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteLocation(id);
      if (!result.ok) setError(result.message ?? 'Could not delete location.');
    });
  }

  return (
    <SettingsCard
      title="Locations"
      description="The physical sites you operate. Reporting and the manifest roll up by location."
      footer={
        !creating && editingId == null ? (
          <PrimaryButton type="button" onClick={beginCreate} disabled={isPending}>
            <Plus className="h-4 w-4" aria-hidden /> Add location
          </PrimaryButton>
        ) : undefined
      }
    >
      {error ? <p className="mb-3 text-sm font-medium text-rose-600">{error}</p> : null}

      {creating ? (
        <LocationEditor draft={draft} setDraft={setDraft} onSave={save} onCancel={cancel} isPending={isPending} />
      ) : null}

      {locations.length === 0 && !creating ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No locations yet. Add your first site to start scheduling activities.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {locations.map((row) =>
            editingId === row.id ? (
              <li key={row.id} className="py-4">
                <LocationEditor
                  draft={draft}
                  setDraft={setDraft}
                  onSave={save}
                  onCancel={cancel}
                  isPending={isPending}
                />
              </li>
            ) : (
              <li key={row.id} className="flex items-center justify-between gap-4 py-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                    <MapPin className="h-4 w-4" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-900">{row.name}</span>
                      {row.isDefault ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                          Default
                        </span>
                      ) : null}
                      {!row.isActive ? (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                          Inactive
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-500">{oneLineAddress(row)}</p>
                  </div>
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

function LocationEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  isPending,
}: {
  draft: LocationDraft;
  setDraft: (d: LocationDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Location name" required className="sm:col-span-2">
          <TextInput
            value={draft.name}
            placeholder="e.g. Main Marina"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label="Street address" className="sm:col-span-2">
          <TextInput
            value={draft.address}
            placeholder="123 Lakeshore Dr"
            onChange={(e) => setDraft({ ...draft, address: e.target.value })}
          />
        </Field>
        <Field label="City">
          <TextInput value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="State">
            <TextInput value={draft.state} onChange={(e) => setDraft({ ...draft, state: e.target.value })} />
          </Field>
          <Field label="ZIP">
            <TextInput value={draft.zip} onChange={(e) => setDraft({ ...draft, zip: e.target.value })} />
          </Field>
        </div>
        <Field label="Timezone" hint="Optional — overrides your operator timezone for this site.">
          <TextInput
            value={draft.timezone}
            placeholder="America/Los_Angeles"
            onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
          />
        </Field>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <CheckboxRow
          label="Default location"
          description="New activities default to this site."
          checked={draft.is_default}
          onChange={(e) => setDraft({ ...draft, is_default: e.target.checked })}
        />
        <CheckboxRow
          label="Active"
          description="Available for scheduling and booking."
          checked={draft.is_active}
          onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })}
        />
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <SecondaryButton type="button" onClick={onCancel} disabled={isPending}>
          <X className="h-4 w-4" aria-hidden /> Cancel
        </SecondaryButton>
        <PrimaryButton type="button" onClick={onSave} disabled={isPending}>
          <Check className="h-4 w-4" aria-hidden /> {isPending ? 'Saving…' : 'Save location'}
        </PrimaryButton>
      </div>
    </div>
  );
}
