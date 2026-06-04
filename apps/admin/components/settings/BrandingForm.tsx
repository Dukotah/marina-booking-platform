'use client';

import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { Field, TextInput, PrimaryButton, SaveStatus, SettingsCard, type SaveState } from './fields';
import { updateBranding, type BrandingInput, type ActionResult } from '../../app/settings/actions';

export interface BrandingFormValues {
  name_internal: string;
  name_external: string;
  website: string;
  phone: string;
  brand_color: string;
  logo_dark_url: string;
  logo_light_url: string;
}

/**
 * Branding editor (white-label). The customer-facing name, logos, and brand color
 * are operator-authored — this is what end customers see, never a platform brand.
 * The live preview shows how the brand color + public name appear on a button so
 * operators can sanity-check contrast before saving.
 */
export function BrandingForm({ initial }: { initial: BrandingFormValues }) {
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [isPending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    formState: { errors, isDirty },
  } = useForm<BrandingFormValues>({ defaultValues: initial });

  const color = watch('brand_color');
  const publicName = watch('name_external');

  function onSubmit(values: BrandingFormValues) {
    setSaveState({ kind: 'idle' });
    startTransition(async () => {
      const result: ActionResult = await updateBranding(values as BrandingInput);
      if (result.ok) {
        setSaveState({ kind: 'saved' });
        return;
      }
      if (result.errors) {
        for (const [path, message] of Object.entries(result.errors)) {
          setError(path as keyof BrandingFormValues, { message });
        }
      }
      setSaveState({ kind: 'error', message: result.message ?? 'Could not save branding.' });
    });
  }

  const validHex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <SettingsCard
        title="Identity"
        description="Your business name as it appears internally and to customers."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Internal name" htmlFor="name_internal" required error={errors.name_internal?.message}>
            <TextInput
              id="name_internal"
              invalid={Boolean(errors.name_internal)}
              {...register('name_internal', { required: 'Internal name is required' })}
            />
          </Field>
          <Field
            label="Public (customer-facing) name"
            htmlFor="name_external"
            required
            hint="Shown to guests on your booking site and emails."
            error={errors.name_external?.message}
          >
            <TextInput
              id="name_external"
              invalid={Boolean(errors.name_external)}
              {...register('name_external', { required: 'Public name is required' })}
            />
          </Field>
          <Field label="Website" htmlFor="website" error={errors.website?.message}>
            <TextInput id="website" type="url" placeholder="https://" {...register('website')} />
          </Field>
          <Field label="Phone" htmlFor="phone" error={errors.phone?.message}>
            <TextInput id="phone" type="tel" placeholder="(555) 555-5555" {...register('phone')} />
          </Field>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Brand color & logos"
        description="Used across your booking site, emails, and the admin rail."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Brand color" htmlFor="brand_color" error={errors.brand_color?.message}>
            <div className="flex items-center gap-3">
              <input
                type="color"
                aria-label="Pick brand color"
                value={validHex ? color : '#0ea5e9'}
                onChange={(e) =>
                  setValue('brand_color', e.target.value, { shouldDirty: true, shouldValidate: true })
                }
                className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-slate-300 bg-white p-1"
              />
              <TextInput
                id="brand_color"
                placeholder="#0ea5e9"
                invalid={Boolean(errors.brand_color)}
                className="font-mono"
                {...register('brand_color', { required: 'Brand color is required' })}
              />
            </div>
          </Field>
          <div className="hidden sm:block" />
          <Field
            label="Logo (dark)"
            htmlFor="logo_dark_url"
            hint="URL of a dark logo for light backgrounds."
            error={errors.logo_dark_url?.message}
          >
            <TextInput id="logo_dark_url" type="url" placeholder="https://" {...register('logo_dark_url')} />
          </Field>
          <Field
            label="Logo (light)"
            htmlFor="logo_light_url"
            hint="URL of a light logo for dark backgrounds (used in the admin rail)."
            error={errors.logo_light_url?.message}
          >
            <TextInput id="logo_light_url" type="url" placeholder="https://" {...register('logo_light_url')} />
          </Field>
        </div>

        <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Preview</p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
              style={{ backgroundColor: validHex ? color : '#94a3b8' }}
            >
              Book {publicName ? `at ${publicName}` : 'now'}
            </button>
            <span className="text-sm font-semibold" style={{ color: validHex ? color : '#94a3b8' }}>
              {publicName || 'Your brand'}
            </span>
          </div>
        </div>
      </SettingsCard>

      <div className="flex items-center justify-end gap-3">
        <SaveStatus state={saveState} />
        <PrimaryButton type="submit" disabled={isPending || !isDirty}>
          {isPending ? 'Saving…' : 'Save branding'}
        </PrimaryButton>
      </div>
    </form>
  );
}
