'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import { setStageAction } from '../actions';
import {
  PIPELINE_STAGES,
  STAGE_LABEL,
  STAGE_MEANING,
  TERMINAL_STAGES,
  stageIndex,
  type OnboardingStageValue,
} from './onboarding-stages';

/**
 * Where this client is, as one click.
 *
 * Native radios inside a fieldset, so the whole thing is arrow-key operable and a
 * screen reader announces "Stage, Configuring, 3 of 6" without any ARIA of our own.
 * The visible chip is a styled sibling of a screen-reader-only input; the focus ring
 * is drawn from the input's focus state so keyboard users can always see where they
 * are.
 *
 * It saves on change. There is no Save button on purpose: the stage is the field most
 * likely to be nudged in passing, and a stage that is one unsaved click out of date is
 * exactly the silent stall this screen exists to prevent.
 */
export function StageControl({
  operatorId,
  stage,
}: {
  operatorId: string;
  stage: OnboardingStageValue;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<OnboardingStageValue>(stage);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  // Arrowing across the group fires one save per stage passed through. Only the
  // newest request may write to the UI, or a slow earlier response lands last and
  // snaps the control back to a stage the owner has already moved off.
  const latest = useRef(0);

  function choose(next: OnboardingStageValue) {
    if (next === selected) return;
    const previous = selected;
    const seq = ++latest.current;
    setSelected(next);
    setError(null);
    setSaved(false);
    start(async () => {
      const result = await setStageAction(operatorId, next);
      if (seq !== latest.current) return;
      if (result.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setSelected(previous);
        setError(result.message ?? 'Could not change the stage. Try again.');
      }
    });
  }

  const currentIndex = stageIndex(selected);

  return (
    <div className="space-y-3">
      {/* Never disabled while saving: taking focus off a radio mid-arrow-key would
          strand a keyboard user. aria-busy says "working" without moving anything. */}
      <fieldset aria-busy={pending || undefined} className="space-y-3">
        <legend className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Stage
        </legend>

        <div className="flex flex-wrap gap-2">
          {PIPELINE_STAGES.map((value, i) => (
            <StageChip
              key={value}
              value={value}
              checked={selected === value}
              done={currentIndex > i}
              onChoose={choose}
            />
          ))}
          <span aria-hidden className="mx-1 hidden self-center text-slate-700 sm:inline">
            |
          </span>
          {TERMINAL_STAGES.map((value) => (
            <StageChip
              key={value}
              value={value}
              checked={selected === value}
              done={false}
              onChoose={choose}
              tone="terminal"
            />
          ))}
        </div>
      </fieldset>

      <p className="text-sm text-slate-400">{STAGE_MEANING[selected]}</p>

      {/* Success is polite; a failure interrupts, because the stage on screen would
          otherwise disagree with the stage in the database. */}
      <p aria-live="polite" className="sr-only">
        {pending ? 'Saving stage' : saved ? `Stage saved as ${STAGE_LABEL[selected]}` : ''}
      </p>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
        >
          {error}
        </p>
      )}
    </div>
  );
}

function StageChip({
  value,
  checked,
  done,
  onChoose,
  tone = 'pipeline',
}: {
  value: OnboardingStageValue;
  checked: boolean;
  done: boolean;
  onChoose: (value: OnboardingStageValue) => void;
  tone?: 'pipeline' | 'terminal';
}) {
  const base =
    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition';
  const state = checked
    ? tone === 'terminal'
      ? 'border-rose-400 bg-rose-500/20 text-rose-100'
      : 'border-emerald-400 bg-emerald-500 text-slate-950'
    : done
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
      : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800';

  return (
    <label className="cursor-pointer">
      <input
        type="radio"
        name="onboarding-stage"
        value={value}
        checked={checked}
        onChange={() => onChoose(value)}
        className="peer sr-only"
      />
      <span
        className={`${base} ${state} peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-400 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-slate-950`}
      >
        {done && <Check className="h-3.5 w-3.5" aria-hidden />}
        {STAGE_LABEL[value]}
        {checked && <span className="sr-only">(current stage)</span>}
      </span>
    </label>
  );
}
