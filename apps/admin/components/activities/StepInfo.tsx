'use client';

import type { ChangeEvent } from 'react';
import type { FieldPath, UseFormReturn } from 'react-hook-form';
import { ACTIVITY_CATEGORIES } from '@marina/core';
import { Field, TextInput, TextArea, Select, CheckboxRow } from './fields';
import { CATEGORY_LABELS, type ActivityFormValues, type LocationOption } from './types';

/**
 * The hide_from_* flags are opt-OUT (true = suppressed), but the operator thinks in
 * "show it here" terms. These are the only fields with inverted meaning, so this
 * subset keeps the helper's prop shape honest without widening it to the whole form.
 */
type HideField = 'hide_from_register' | 'hide_from_kiosk' | 'hide_from_display';

/**
 * Step 1 — Info. The core identity of the activity: names, category, location,
 * participant limits, color, and where it is visible. White-label safe: the
 * external name is operator-authored, never a platform default.
 */
export function StepInfo({
  form,
  locations,
}: {
  form: UseFormReturn<ActivityFormValues>;
  locations: LocationOption[];
}) {
  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = form;

  const color = watch('color');

  /**
   * A "Show on <channel>" checkbox backed by an opt-OUT `hide_from_*` field.
   * Checked means visible, so the box reflects `!hidden` and writes back the inverse.
   * The field is still registered (so RHF tracks it); we only override checked/onChange.
   */
  function registerHide(name: HideField) {
    const reg = register(name as FieldPath<ActivityFormValues>);
    return {
      ...reg,
      checked: !watch(name),
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        setValue(name, !e.target.checked, { shouldDirty: true, shouldTouch: true });
      },
    };
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Internal name" htmlFor="name_internal" required error={errors.name_internal?.message}>
          <TextInput
            id="name_internal"
            placeholder="e.g. 24' Pontoon"
            invalid={Boolean(errors.name_internal)}
            {...register('name_internal', { required: 'Internal name is required' })}
          />
        </Field>

        <Field
          label="Customer-facing name"
          htmlFor="name_external"
          required
          hint="What guests see when booking online."
          error={errors.name_external?.message}
        >
          <TextInput
            id="name_external"
            placeholder="e.g. 24-Foot Pontoon Boat"
            invalid={Boolean(errors.name_external)}
            {...register('name_external', { required: 'Customer-facing name is required' })}
          />
        </Field>

        <Field label="Category" htmlFor="category" error={errors.category?.message}>
          <Select id="category" {...register('category')}>
            {ACTIVITY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Location"
          htmlFor="location_id"
          hint={locations.length ? 'Leave blank to apply to all locations.' : 'No locations configured yet.'}
          error={errors.location_id?.message}
        >
          <Select id="location_id" {...register('location_id')}>
            <option value="">All locations</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Minimum participants"
          htmlFor="min_participants"
          error={errors.min_participants?.message}
        >
          <TextInput
            id="min_participants"
            type="number"
            min={1}
            invalid={Boolean(errors.min_participants)}
            {...register('min_participants', {
              valueAsNumber: true,
              min: { value: 1, message: 'Must be at least 1' },
            })}
          />
        </Field>

        <Field
          label="Maximum participants"
          htmlFor="max_participants"
          error={errors.max_participants?.message}
        >
          <TextInput
            id="max_participants"
            type="number"
            min={1}
            invalid={Boolean(errors.max_participants)}
            {...register('max_participants', {
              valueAsNumber: true,
              min: { value: 1, message: 'Must be at least 1' },
              validate: (v) =>
                v >= form.getValues('min_participants') || 'Must be ≥ minimum participants',
            })}
          />
        </Field>
      </div>

      <Field label="Description" htmlFor="description_html" hint="Shown on the booking page. Plain text or simple HTML.">
        <TextArea
          id="description_html"
          placeholder="Describe this activity for your guests…"
          {...register('description_html')}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Calendar color" htmlFor="color" hint="Used on the manifest and calendar.">
          <div className="flex items-center gap-3">
            <input
              id="color"
              type="color"
              className="h-10 w-14 cursor-pointer rounded-lg border border-slate-300 bg-white p-1"
              {...register('color')}
            />
            <span className="text-sm text-slate-500">{color}</span>
          </div>
        </Field>

        <Field
          label="Self-reschedule window (hours)"
          htmlFor="self_reschedule_hours"
          hint="How far ahead guests may reschedule themselves."
          error={errors.self_reschedule_hours?.message}
        >
          <TextInput
            id="self_reschedule_hours"
            type="number"
            min={0}
            {...register('self_reschedule_hours', {
              valueAsNumber: true,
              min: { value: 0, message: 'Cannot be negative' },
            })}
          />
        </Field>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-slate-700">Visibility &amp; channels</legend>
        <p className="text-xs text-slate-500">
          Choose where this activity shows up. Tick a channel to list it there; untick to
          hide it from just that channel. The others are unaffected.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <CheckboxRow
            label="Show on public booking site (online)"
            description="Guests can find and book it on your website."
            {...register('visible_online')}
          />
          <CheckboxRow
            label="Show on register"
            description="Staff can sell it at the point of sale."
            // Register has an opt-in (visible_register) and an opt-out
            // (hide_from_register). Both must agree for the activity to appear, so the
            // one checkbox the operator sees drives the opt-out flag (checked = not
            // hidden) and we keep visible_register ticked for them below.
            {...registerHide('hide_from_register')}
          />
          <CheckboxRow
            label="Show on kiosk"
            description="Guests can self-serve at a kiosk."
            {...registerHide('hide_from_kiosk')}
          />
          <CheckboxRow
            label="Show on departures display"
            description="Appears on the big “what's leaving today” board."
            {...registerHide('hide_from_display')}
          />
        </div>
        {/* The register/kiosk opt-in flags are implied by the toggles above; keep them
            on so the opt-out checkbox is the single source of truth the operator reads. */}
        <input type="hidden" value="true" {...register('visible_register')} />
        <input type="hidden" value="true" {...register('visible_kiosk')} />
        <div className="grid gap-2 sm:grid-cols-2">
          <CheckboxRow
            label="Hide the price (show “call for price”)"
            description="Still lists the activity, but no rate is shown to guests."
            {...register('hide_price')}
          />
          <CheckboxRow
            label="Require waiver"
            description="Guests must sign a waiver before this activity."
            {...register('waiver_required')}
          />
        </div>
      </fieldset>
    </div>
  );
}
