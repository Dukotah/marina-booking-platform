'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, type FieldPath } from 'react-hook-form';
import { Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { toCents } from '../../lib/format';
import { cn } from '../../lib/cn';
import { StepInfo } from './StepInfo';
import { StepRates } from './StepRates';
import { StepSchedule } from './StepSchedule';
import { StepPreview } from './StepPreview';
import type { ActivityFormValues, LocationOption } from './types';
import {
  createActivity,
  updateActivity,
  type ActionResult,
  type WizardInput,
} from '../../app/activities/actions';

/**
 * The 4-step activity create/edit wizard: Info → Rates → Schedule → Preview.
 * Deliberately far simpler than Singenuity's 10-tab editor. State is held in one
 * react-hook-form instance; each step validates only its own fields before
 * advancing. On the final step it converts dollars→cents and calls the matching
 * server action (create or update), both gated by `activity:write`.
 */

const STEPS = ['Info', 'Rates', 'Schedule', 'Preview'] as const;
type StepIndex = 0 | 1 | 2 | 3;

/** Which fields each step owns, for per-step validation gating. */
const STEP_FIELDS: Record<number, Array<FieldPath<ActivityFormValues>>> = {
  0: [
    'name_internal',
    'name_external',
    'category',
    'location_id',
    'min_participants',
    'max_participants',
    'self_reschedule_hours',
  ],
  1: ['rates'],
  2: [
    'schedule.open_hour',
    'schedule.close_hour',
    'schedule.interval_minutes',
    'schedule.capacity_total',
  ],
  3: [],
};

/** Map the client form shape to the server WizardInput (dollars -> cents). */
function toWizardInput(values: ActivityFormValues): WizardInput {
  return {
    activity: {
      name_internal: values.name_internal,
      name_external: values.name_external,
      category: values.category,
      status: values.status,
      location_id: values.location_id || undefined,
      visible_online: values.visible_online,
      visible_kiosk: values.visible_kiosk,
      visible_register: values.visible_register,
      min_participants: values.min_participants,
      max_participants: values.max_participants,
      description_html: values.description_html || undefined,
      photo_urls: values.photo_urls,
      color: values.color,
      waiver_required: values.waiver_required,
      self_reschedule_hours: values.self_reschedule_hours,
      sort_index: 0,
      config: {
        schedule: {
          open_hour: values.schedule.open_hour,
          close_hour: values.schedule.close_hour,
          interval_minutes: values.schedule.interval_minutes,
          capacity_total: values.schedule.capacity_total,
        },
      },
    },
    rates: values.rates.map((r) => ({
      id: r.id,
      name_internal: r.name_internal,
      name_external: r.name_external,
      price_cents: toCents(Number(r.price_dollars) || 0),
      duration_minutes: r.duration_minutes,
      is_active: r.is_active,
      online_only: r.online_only,
      internal_only: r.internal_only,
      is_from_price: r.is_from_price,
      sort_index: 0,
    })),
  };
}

export function ActivityWizard({
  mode,
  activityId,
  defaultValues,
  locations,
}: {
  mode: 'create' | 'edit';
  activityId?: string;
  defaultValues: ActivityFormValues;
  locations: LocationOption[];
}) {
  const router = useRouter();
  const [step, setStep] = useState<StepIndex>(0);
  const [isPending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const form = useForm<ActivityFormValues>({
    defaultValues,
    mode: 'onTouched',
  });

  async function next() {
    setFormError(null);
    const fields = STEP_FIELDS[step];
    const valid = fields.length === 0 ? true : await form.trigger(fields);
    if (!valid) return;
    setStep((s) => (Math.min(s + 1, STEPS.length - 1) as StepIndex));
  }

  function back() {
    setFormError(null);
    setStep((s) => (Math.max(s - 1, 0) as StepIndex));
  }

  /** Surface server-side field errors back onto the form. */
  function applyServerErrors(result: ActionResult) {
    if (result.errors) {
      for (const [path, message] of Object.entries(result.errors)) {
        // Server paths are prefixed with "activity." / "rates." — strip the
        // "activity." prefix so they map onto the flat form fields.
        const formPath = path.startsWith('activity.')
          ? path.slice('activity.'.length)
          : path;
        form.setError(formPath as FieldPath<ActivityFormValues>, { message });
      }
      setStep(0);
    }
    if (result.message) setFormError(result.message);
  }

  function submit() {
    setFormError(null);
    // Full validation before persisting.
    void form.handleSubmit((values) => {
      const payload = toWizardInput(values);
      startTransition(async () => {
        if (mode === 'create') {
          // createActivity redirects on success; a returned result means failure.
          const result = await createActivity(payload);
          applyServerErrors(result);
        } else if (activityId) {
          const result = await updateActivity(activityId, payload);
          if (result.ok) {
            setSaved(true);
            router.refresh();
          } else {
            applyServerErrors(result);
          }
        }
      });
    })();
  }

  return (
    <div className="space-y-6">
      {/* Stepper */}
      <ol className="flex items-center gap-2">
        {STEPS.map((label, i) => {
          const active = i === step;
          const complete = i < step;
          return (
            <li key={label} className="flex flex-1 items-center gap-2">
              <button
                type="button"
                onClick={() => i <= step && setStep(i as StepIndex)}
                disabled={i > step}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  active
                    ? 'bg-slate-900 text-white'
                    : complete
                      ? 'text-slate-700 hover:bg-slate-100'
                      : 'text-slate-400',
                )}
              >
                <span
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-full text-xs',
                    active
                      ? 'bg-white text-slate-900'
                      : complete
                        ? 'bg-emerald-500 text-white'
                        : 'bg-slate-200 text-slate-500',
                  )}
                >
                  {complete ? <Check className="h-3 w-3" aria-hidden /> : i + 1}
                </span>
                {label}
              </button>
              {i < STEPS.length - 1 ? (
                <span className={cn('h-px flex-1', complete ? 'bg-emerald-400' : 'bg-slate-200')} />
              ) : null}
            </li>
          );
        })}
      </ol>

      {formError ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {formError}
        </div>
      ) : null}
      {saved ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          Changes saved.
        </div>
      ) : null}

      {/* Step body */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        {step === 0 ? <StepInfo form={form} locations={locations} /> : null}
        {step === 1 ? <StepRates form={form} /> : null}
        {step === 2 ? <StepSchedule form={form} /> : null}
        {step === 3 ? <StepPreview form={form} /> : null}
      </div>

      {/* Footer nav */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={back}
          disabled={step === 0 || isPending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Back
        </button>

        {step < STEPS.length - 1 ? (
          <button
            type="button"
            onClick={next}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Continue
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
            {mode === 'create' ? 'Create activity' : 'Save changes'}
          </button>
        )}
      </div>
    </div>
  );
}
