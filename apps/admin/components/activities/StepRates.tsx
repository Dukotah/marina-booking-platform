'use client';

import { useFieldArray, type UseFormReturn } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import { Field, TextInput, Select, CheckboxRow } from './fields';
import {
  emptyRate,
  emptyRateClass,
  RATE_CLASS_KIND_LABELS,
  type ActivityFormValues,
} from './types';

/**
 * Per-head rate classes for one rate (adult / child / …). Each class is a label +
 * an OPTIONAL signed price modifier (in dollars, converted to cents on submit)
 * applied on top of the rate's base price. A rate with no classes stays
 * single-quantity. The customer checkout renders a per-class stepper when a rate
 * has classes. This is its own component because react-hook-form's useFieldArray
 * must be called at the top level of a component (one per rate).
 */
function RateClassEditor({
  form,
  rateIndex,
}: {
  form: UseFormReturn<ActivityFormValues>;
  rateIndex: number;
}) {
  const { register, control } = form;
  const { fields, append, remove } = useFieldArray({
    control,
    name: `rates.${rateIndex}.rate_classes`,
    keyName: '_key',
  });

  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            Per-head guest types
          </h4>
          <p className="text-xs text-slate-500">
            Optional. Price adults, children, etc. differently. Leave empty for a
            single price per guest.
          </p>
        </div>
        <button
          type="button"
          onClick={() => append(emptyRateClass())}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-2 text-xs font-medium text-white hover:bg-teal-600"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add guest type
        </button>
      </div>

      {fields.length === 0 ? null : (
        <div className="space-y-2">
          {fields.map((field, j) => (
            <div
              key={field._key}
              className="grid items-end gap-2 rounded-md border border-slate-200 bg-white p-2 sm:grid-cols-[1fr_1fr_auto_auto]"
            >
              <Field label="Type">
                <Select {...register(`rates.${rateIndex}.rate_classes.${j}.kind`)}>
                  {Object.entries(RATE_CLASS_KIND_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Label">
                <TextInput
                  placeholder="e.g. Child (3-12)"
                  {...register(`rates.${rateIndex}.rate_classes.${j}.label`, {
                    required: 'Label is required',
                  })}
                />
              </Field>
              <Field label="Price +/- (USD)">
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                    $
                  </span>
                  <TextInput
                    type="number"
                    step="0.01"
                    className="w-28 pl-7"
                    {...register(`rates.${rateIndex}.rate_classes.${j}.price_modifier_dollars`, {
                      valueAsNumber: true,
                      validate: (v) =>
                        (!Number.isNaN(v) && Number.isFinite(v)) || 'Enter a valid amount',
                    })}
                  />
                </div>
              </Field>
              <button
                type="button"
                onClick={() => remove(j)}
                aria-label="Remove guest type"
                className="inline-flex min-h-[44px] items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Step 2 — Rates. Each rate is a priced duration/option (e.g. "Half Day · $350").
 * Prices are entered in dollars and converted to integer cents on submit by the
 * wizard. A rate card can be removed; at least one active rate is recommended but
 * not forced (an activity can be drafted before pricing).
 */
export function StepRates({ form }: { form: UseFormReturn<ActivityFormValues> }) {
  const {
    register,
    control,
    formState: { errors },
  } = form;

  // Use a non-colliding key field: our rate data already has an `id` (existing
  // rates), so we must not let react-hook-form overwrite it with its own `id`.
  const { fields, append, remove } = useFieldArray({ control, name: 'rates', keyName: '_key' });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          Add the priced options guests can choose (Half Day, Full Day, etc.).
        </p>
        <button
          type="button"
          onClick={() => append(emptyRate())}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add rate
        </button>
      </div>

      {fields.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No rates yet. Add at least one priced option so guests can book.
        </div>
      ) : (
        <div className="space-y-4">
          {fields.map((field, index) => {
            const rateErrors = errors.rates?.[index];
            return (
              <div key={field._key} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-700">Rate {index + 1}</h3>
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    Remove
                  </button>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Internal name"
                    required
                    error={rateErrors?.name_internal?.message}
                  >
                    <TextInput
                      placeholder="e.g. Half Day"
                      invalid={Boolean(rateErrors?.name_internal)}
                      {...register(`rates.${index}.name_internal`, {
                        required: 'Internal name is required',
                      })}
                    />
                  </Field>

                  <Field
                    label="Customer-facing name"
                    required
                    error={rateErrors?.name_external?.message}
                  >
                    <TextInput
                      placeholder="e.g. Half Day (4 hours)"
                      invalid={Boolean(rateErrors?.name_external)}
                      {...register(`rates.${index}.name_external`, {
                        required: 'Customer-facing name is required',
                      })}
                    />
                  </Field>

                  <Field label="Price (USD)" required error={rateErrors?.price_dollars?.message}>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                        $
                      </span>
                      <TextInput
                        type="number"
                        min={0}
                        step="0.01"
                        className="pl-7"
                        invalid={Boolean(rateErrors?.price_dollars)}
                        {...register(`rates.${index}.price_dollars`, {
                          valueAsNumber: true,
                          min: { value: 0, message: 'Price cannot be negative' },
                          validate: (v) =>
                            (!Number.isNaN(v) && Number.isFinite(v)) || 'Enter a valid price',
                        })}
                      />
                    </div>
                  </Field>

                  <Field
                    label="Duration (minutes)"
                    required
                    error={rateErrors?.duration_minutes?.message}
                  >
                    <TextInput
                      type="number"
                      min={1}
                      invalid={Boolean(rateErrors?.duration_minutes)}
                      {...register(`rates.${index}.duration_minutes`, {
                        valueAsNumber: true,
                        min: { value: 1, message: 'Must be at least 1 minute' },
                      })}
                    />
                  </Field>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <CheckboxRow label="Active" description="Available for booking." {...register(`rates.${index}.is_active`)} />
                  <CheckboxRow
                    label="From price"
                    description="Show as a 'from' starting price."
                    {...register(`rates.${index}.is_from_price`)}
                  />
                  <CheckboxRow
                    label="Online only"
                    description="Only bookable on the public site."
                    {...register(`rates.${index}.online_only`)}
                  />
                  <CheckboxRow
                    label="Internal only"
                    description="Only bookable by staff."
                    {...register(`rates.${index}.internal_only`)}
                  />
                </div>

                <RateClassEditor form={form} rateIndex={index} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
