'use client';

import { useMemo, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronLeft, ChevronRight, Plus, Trash2, Sparkles } from 'lucide-react';
import { Field, TextInput, Select, PrimaryButton, SecondaryButton } from './fields';
import { completeOnboarding, type OnboardingInput, type OnboardingResult } from '../../app/onboarding/actions';

const CATEGORY_OPTIONS = [
  { value: 'BOAT', label: 'Boat' },
  { value: 'WATERCRAFT', label: 'Watercraft' },
  { value: 'PATIO', label: 'Patio' },
  { value: 'LODGING', label: 'Lodging' },
  { value: 'TOUR', label: 'Tour' },
  { value: 'CLASS', label: 'Class' },
  { value: 'EVENT', label: 'Event' },
  { value: 'EQUIPMENT', label: 'Equipment' },
  { value: 'OTHER', label: 'Other' },
] as const;

type Category = (typeof CATEGORY_OPTIONS)[number]['value'];

interface ActivityDraft {
  name_external: string;
  category: Category;
}

interface WizardState {
  brand: {
    name_external: string;
    name_internal: string;
    brand_color: string;
    website: string;
    phone: string;
  };
  location: {
    name: string;
    address: string;
    city: string;
    state: string;
    zip: string;
  };
  activities: ActivityDraft[];
}

export interface OnboardingDefaults {
  name_external: string;
  name_internal: string;
  brand_color: string;
  website: string;
  phone: string;
}

const STEPS = ['Brand', 'Location', 'Activities', 'Review'] as const;

/**
 * Guided onboarding for a new operator: brand → first location → first activities
 * → review. Validates per-step client-side, then provisions everything in one
 * tenant-scoped transaction via completeOnboarding. White-label: the public name
 * and brand color are operator-authored from the very first screen.
 */
export function OnboardingWizard({ defaults }: { defaults: OnboardingDefaults }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [state, setState] = useState<WizardState>({
    brand: {
      name_external: defaults.name_external,
      name_internal: defaults.name_internal,
      brand_color: defaults.brand_color || '#0ea5e9',
      website: defaults.website,
      phone: defaults.phone,
    },
    location: { name: '', address: '', city: '', state: '', zip: '' },
    activities: [{ name_external: '', category: 'BOAT' }],
  });

  const validHex = useMemo(
    () => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(state.brand.brand_color),
    [state.brand.brand_color],
  );

  function setBrand(patch: Partial<WizardState['brand']>) {
    setState((s) => ({ ...s, brand: { ...s.brand, ...patch } }));
  }
  function setLocation(patch: Partial<WizardState['location']>) {
    setState((s) => ({ ...s, location: { ...s.location, ...patch } }));
  }
  function setActivity(index: number, patch: Partial<ActivityDraft>) {
    setState((s) => ({
      ...s,
      activities: s.activities.map((a, i) => (i === index ? { ...a, ...patch } : a)),
    }));
  }
  function addActivity() {
    setState((s) => ({ ...s, activities: [...s.activities, { name_external: '', category: 'OTHER' }] }));
  }
  function removeActivity(index: number) {
    setState((s) => ({ ...s, activities: s.activities.filter((_, i) => i !== index) }));
  }

  /** Validate the current step; returns true when it may advance. */
  function validateStep(current: number): boolean {
    const next: Record<string, string> = {};
    if (current === 0) {
      if (!state.brand.name_external.trim()) next['brand.name_external'] = 'Public name is required';
      if (!validHex) next['brand.brand_color'] = 'Pick a valid color';
    } else if (current === 1) {
      if (!state.location.name.trim()) next['location.name'] = 'Location name is required';
    } else if (current === 2) {
      const named = state.activities.filter((a) => a.name_external.trim());
      if (named.length === 0) next['activities'] = 'Add at least one activity';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function goNext() {
    setServerError(null);
    if (validateStep(step)) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }
  function goBack() {
    setServerError(null);
    setErrors({});
    setStep((s) => Math.max(s - 1, 0));
  }

  function finish() {
    // Final guard across all steps.
    if (!validateStep(0)) return setStep(0);
    if (!validateStep(1)) return setStep(1);
    if (!validateStep(2)) return setStep(2);

    const payload: OnboardingInput = {
      brand: {
        name_external: state.brand.name_external.trim(),
        name_internal: state.brand.name_internal.trim(),
        brand_color: state.brand.brand_color,
        website: state.brand.website.trim(),
        phone: state.brand.phone.trim(),
      },
      location: {
        name: state.location.name.trim(),
        address: state.location.address.trim(),
        city: state.location.city.trim(),
        state: state.location.state.trim(),
        zip: state.location.zip.trim(),
      },
      activities: state.activities
        .filter((a) => a.name_external.trim())
        .map((a) => ({ name_external: a.name_external.trim(), category: a.category })),
    };

    setServerError(null);
    startTransition(async () => {
      const result: OnboardingResult = await completeOnboarding(payload);
      if (result.ok) {
        router.push('/settings');
        router.refresh();
        return;
      }
      if (result.errors) setErrors(result.errors);
      setServerError(result.message ?? 'Could not complete setup. Check the highlighted fields.');
    });
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Stepper step={step} />

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        {step === 0 ? (
          <div className="space-y-5">
            <Header
              title="Make it yours"
              subtitle="Your customers will only ever see your brand — never ours."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Public business name" required error={errors['brand.name_external']} className="sm:col-span-2">
                <TextInput
                  value={state.brand.name_external}
                  placeholder="e.g. Harbor Adventures"
                  invalid={Boolean(errors['brand.name_external'])}
                  onChange={(e) => setBrand({ name_external: e.target.value })}
                />
              </Field>
              <Field label="Brand color" error={errors['brand.brand_color']}>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    aria-label="Pick brand color"
                    value={validHex ? state.brand.brand_color : '#0ea5e9'}
                    onChange={(e) => setBrand({ brand_color: e.target.value })}
                    className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-slate-300 bg-white p-1"
                  />
                  <TextInput
                    className="font-mono"
                    value={state.brand.brand_color}
                    onChange={(e) => setBrand({ brand_color: e.target.value })}
                  />
                </div>
              </Field>
              <Field label="Website">
                <TextInput
                  type="url"
                  placeholder="https://"
                  value={state.brand.website}
                  onChange={(e) => setBrand({ website: e.target.value })}
                />
              </Field>
              <Field label="Phone">
                <TextInput
                  type="tel"
                  value={state.brand.phone}
                  onChange={(e) => setBrand({ phone: e.target.value })}
                />
              </Field>
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="space-y-5">
            <Header
              title="Where do you operate?"
              subtitle="Add your first site. You can add more locations later."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Location name" required error={errors['location.name']} className="sm:col-span-2">
                <TextInput
                  value={state.location.name}
                  placeholder="e.g. Main Marina"
                  invalid={Boolean(errors['location.name'])}
                  onChange={(e) => setLocation({ name: e.target.value })}
                />
              </Field>
              <Field label="Street address" className="sm:col-span-2">
                <TextInput
                  value={state.location.address}
                  onChange={(e) => setLocation({ address: e.target.value })}
                />
              </Field>
              <Field label="City">
                <TextInput value={state.location.city} onChange={(e) => setLocation({ city: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="State">
                  <TextInput value={state.location.state} onChange={(e) => setLocation({ state: e.target.value })} />
                </Field>
                <Field label="ZIP">
                  <TextInput value={state.location.zip} onChange={(e) => setLocation({ zip: e.target.value })} />
                </Field>
              </div>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="space-y-5">
            <Header
              title="What can people book?"
              subtitle="Add a few starter activities. You can fully configure rates and schedules afterward."
            />
            {errors['activities'] ? (
              <p className="text-sm font-medium text-rose-600">{errors['activities']}</p>
            ) : null}
            <div className="space-y-3">
              {state.activities.map((a, i) => (
                <div key={i} className="flex items-end gap-3">
                  <Field label={`Activity ${i + 1}`} className="flex-1">
                    <TextInput
                      value={a.name_external}
                      placeholder="e.g. 24' Pontoon Rental"
                      onChange={(e) => setActivity(i, { name_external: e.target.value })}
                    />
                  </Field>
                  <Field label="Type" className="w-40">
                    <Select
                      value={a.category}
                      onChange={(e) => setActivity(i, { category: e.target.value as Category })}
                    >
                      {CATEGORY_OPTIONS.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <button
                    type="button"
                    onClick={() => removeActivity(i)}
                    disabled={state.activities.length === 1}
                    aria-label={`Remove activity ${i + 1}`}
                    className="mb-2 rounded-md p-2 text-rose-500 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
            <SecondaryButton type="button" onClick={addActivity}>
              <Plus className="h-4 w-4" aria-hidden /> Add another
            </SecondaryButton>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-5">
            <Header title="Review & finish" subtitle="Confirm your setup. You can change anything later in Settings." />
            <dl className="space-y-4 text-sm">
              <ReviewRow label="Brand">
                <span className="inline-flex items-center gap-2">
                  <span
                    className="h-4 w-4 rounded-full border border-slate-300"
                    style={{ backgroundColor: validHex ? state.brand.brand_color : '#e2e8f0' }}
                    aria-hidden
                  />
                  <span className="font-medium text-slate-900">{state.brand.name_external || '—'}</span>
                </span>
              </ReviewRow>
              <ReviewRow label="Location">
                <span className="font-medium text-slate-900">{state.location.name || '—'}</span>
                {state.location.city ? (
                  <span className="text-slate-500">
                    {' '}
                    · {[state.location.city, state.location.state].filter(Boolean).join(', ')}
                  </span>
                ) : null}
              </ReviewRow>
              <ReviewRow label="Activities">
                <ul className="space-y-1">
                  {state.activities
                    .filter((a) => a.name_external.trim())
                    .map((a, i) => (
                      <li key={i} className="text-slate-900">
                        {a.name_external}{' '}
                        <span className="text-xs text-slate-400">
                          ({CATEGORY_OPTIONS.find((c) => c.value === a.category)?.label})
                        </span>
                      </li>
                    ))}
                </ul>
              </ReviewRow>
            </dl>
            {serverError ? <p className="text-sm font-medium text-rose-600">{serverError}</p> : null}
          </div>
        ) : null}

        <div className="mt-8 flex items-center justify-between border-t border-slate-100 pt-5">
          <SecondaryButton type="button" onClick={goBack} disabled={step === 0 || isPending}>
            <ChevronLeft className="h-4 w-4" aria-hidden /> Back
          </SecondaryButton>
          {step < STEPS.length - 1 ? (
            <PrimaryButton type="button" onClick={goNext}>
              Continue <ChevronRight className="h-4 w-4" aria-hidden />
            </PrimaryButton>
          ) : (
            <PrimaryButton type="button" onClick={finish} disabled={isPending}>
              <Sparkles className="h-4 w-4" aria-hidden /> {isPending ? 'Setting up…' : 'Finish setup'}
            </PrimaryButton>
          )}
        </div>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <ol className="mb-6 flex items-center gap-2" aria-label="Onboarding progress">
      {STEPS.map((label, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={[
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                done
                  ? 'bg-emerald-500 text-white'
                  : active
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-200 text-slate-500',
              ].join(' ')}
            >
              {done ? <Check className="h-4 w-4" aria-hidden /> : i + 1}
            </span>
            <span
              className={[
                'hidden text-sm font-medium sm:inline',
                active ? 'text-slate-900' : 'text-slate-400',
              ].join(' ')}
            >
              {label}
            </span>
            {i < STEPS.length - 1 ? <span className="h-px flex-1 bg-slate-200" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
    </div>
  );
}

function ReviewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-4">
      <dt className="w-24 shrink-0 text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
