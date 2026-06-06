'use client';

import { useState, useTransition } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Field, TextInput, Select } from '../activities/fields';
import {
  type ResourceFormValues,
  type SelectOption,
  type AllocationMode,
  ALLOCATION_MODE_LABELS,
  ALLOCATION_MODE_DESCRIPTIONS,
  emptyResourceForm,
} from './types';
import type { ResourceListItem } from './types';
import { createResource, updateResource, type ResourceInput } from '../../app/resources/actions';

/**
 * Create / edit form for a Resource. Used in a slide-over panel on the list
 * page. Handles client-side validation (outOfServiceQty <= quantity) before
 * calling the server action.
 */
export function ResourceForm({
  mode,
  resource,
  locations,
  activities,
  onSuccess,
  onCancel,
}: {
  mode: 'create' | 'edit';
  resource?: ResourceListItem & { activityIds?: string[] };
  locations: SelectOption[];
  activities: SelectOption[];
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof ResourceFormValues, string>>>({});
  const [saved, setSaved] = useState(false);

  const [values, setValues] = useState<ResourceFormValues>(() => {
    if (mode === 'edit' && resource) {
      return {
        name: resource.name,
        seatCapacity: resource.seatCapacity,
        quantity: resource.quantity,
        outOfServiceQty: resource.outOfServiceQty,
        allocationMode: resource.allocationMode,
        enableTimer: resource.enableTimer,
        locationId: resource.locationId ?? '',
        activityIds: resource.activityIds ?? [],
      };
    }
    return emptyResourceForm();
  });

  function set<K extends keyof ResourceFormValues>(key: K, value: ResourceFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function validate(): boolean {
    const errors: Partial<Record<keyof ResourceFormValues, string>> = {};
    if (!values.name.trim()) errors.name = 'Name is required.';
    if (values.name.trim().length > 160) errors.name = 'Name must be 160 characters or fewer.';
    if (!Number.isInteger(values.seatCapacity) || values.seatCapacity < 1)
      errors.seatCapacity = 'Seat capacity must be a positive integer.';
    if (!Number.isInteger(values.quantity) || values.quantity < 0)
      errors.quantity = 'Quantity must be 0 or more.';
    if (!Number.isInteger(values.outOfServiceQty) || values.outOfServiceQty < 0)
      errors.outOfServiceQty = 'Out-of-service count must be 0 or more.';
    if (values.outOfServiceQty > values.quantity)
      errors.outOfServiceQty = `Cannot exceed quantity (${values.quantity}).`;
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function handleSubmit() {
    setFormError(null);
    setSaved(false);
    if (!validate()) return;

    const input: ResourceInput = {
      name: values.name.trim(),
      seatCapacity: values.seatCapacity,
      quantity: values.quantity,
      outOfServiceQty: values.outOfServiceQty,
      allocationMode: values.allocationMode,
      enableTimer: values.enableTimer,
      locationId: values.locationId || null,
      activityIds: values.activityIds,
    };

    startTransition(async () => {
      const result =
        mode === 'create'
          ? await createResource(input)
          : await updateResource(resource!.id, input);

      if (result.ok) {
        setSaved(true);
        setTimeout(() => onSuccess(), 800);
      } else {
        setFormError(result.error);
      }
    });
  }

  function toggleActivity(id: string) {
    set(
      'activityIds',
      values.activityIds.includes(id)
        ? values.activityIds.filter((a) => a !== id)
        : [...values.activityIds, id],
    );
  }

  const availableQty = Math.max(0, values.quantity - values.outOfServiceQty);

  return (
    <div className="flex flex-col gap-5">
      {/* Success banner */}
      {saved ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {mode === 'create' ? 'Resource created.' : 'Changes saved.'}
        </div>
      ) : null}

      {/* Error banner */}
      {formError ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {formError}
        </div>
      ) : null}

      {/* Name */}
      <Field label="Name" htmlFor="res-name" required error={fieldErrors.name}>
        <TextInput
          id="res-name"
          value={values.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="e.g. 10-Person Pontoon"
          maxLength={160}
          invalid={Boolean(fieldErrors.name)}
        />
      </Field>

      {/* Allocation mode */}
      <Field label="Allocation mode" htmlFor="res-mode" required error={fieldErrors.allocationMode}>
        <Select
          id="res-mode"
          value={values.allocationMode}
          onChange={(e) => set('allocationMode', e.target.value as AllocationMode)}
          invalid={Boolean(fieldErrors.allocationMode)}
        >
          {(['SHARED_SEATS', 'WHOLE_UNIT'] as const).map((m) => (
            <option key={m} value={m}>
              {ALLOCATION_MODE_LABELS[m]}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-slate-400">{ALLOCATION_MODE_DESCRIPTIONS[values.allocationMode]}</p>
      </Field>

      {/* Capacity + inventory row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Seats per unit" htmlFor="res-seats" required error={fieldErrors.seatCapacity}
          hint="How many people fit in one unit">
          <TextInput
            id="res-seats"
            type="number"
            min={1}
            step={1}
            value={values.seatCapacity}
            onChange={(e) => set('seatCapacity', Math.max(1, parseInt(e.target.value, 10) || 1))}
            invalid={Boolean(fieldErrors.seatCapacity)}
          />
        </Field>

        <Field label="Units owned" htmlFor="res-qty" required error={fieldErrors.quantity}
          hint="Total in your inventory">
          <TextInput
            id="res-qty"
            type="number"
            min={0}
            step={1}
            value={values.quantity}
            onChange={(e) => set('quantity', Math.max(0, parseInt(e.target.value, 10) || 0))}
            invalid={Boolean(fieldErrors.quantity)}
          />
        </Field>

        <Field label="Out of service" htmlFor="res-oos" required error={fieldErrors.outOfServiceQty}
          hint={`Available: ${availableQty}`}>
          <TextInput
            id="res-oos"
            type="number"
            min={0}
            step={1}
            value={values.outOfServiceQty}
            onChange={(e) =>
              set('outOfServiceQty', Math.max(0, parseInt(e.target.value, 10) || 0))
            }
            invalid={Boolean(fieldErrors.outOfServiceQty)}
          />
        </Field>
      </div>

      {/* Location */}
      <Field label="Location" htmlFor="res-loc" hint="Optional home location for this asset">
        <Select
          id="res-loc"
          value={values.locationId}
          onChange={(e) => set('locationId', e.target.value)}
        >
          <option value="">— No location —</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>

      {/* Activity assignment */}
      <Field
        label="Assigned activities"
        hint="This resource backs the capacity of every checked activity."
      >
        {activities.length === 0 ? (
          <p className="text-xs text-slate-400">No activities found. Create activities first.</p>
        ) : (
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {activities.map((a) => {
              const checked = values.activityIds.includes(a.id);
              return (
                <label
                  key={a.id}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors',
                    checked
                      ? 'border-slate-400 bg-slate-50 font-medium text-slate-900'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50',
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-400"
                    checked={checked}
                    onChange={() => toggleActivity(a.id)}
                  />
                  <span className="truncate">{a.name}</span>
                </label>
              );
            })}
          </div>
        )}
      </Field>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <X className="h-4 w-4" aria-hidden />
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isPending || saved}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Check className="h-4 w-4" aria-hidden />
          )}
          {mode === 'create' ? 'Create resource' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
