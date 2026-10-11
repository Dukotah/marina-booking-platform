'use client';

import { useId, useMemo, useState, useTransition } from 'react';
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { formatUSD } from '../../lib/format';
import {
  CheckboxRow,
  Field,
  PrimaryButton,
  SecondaryButton,
  Select,
  SettingsCard,
  TextInput,
} from './fields';

/**
 * Dynamic pricing rules — the operator's control over what a slot is worth.
 *
 * The design problem here is trust, not CRUD. An operator will happily add a
 * "+20% on summer weekends" rule and then never turn it on, because they cannot
 * see what it does to a real booking until a real guest is charged. So the
 * preview is not a nicety bolted on the side: it is the primary control. It runs
 * the SAME `@marina/core` engine the booking path runs, against the rate's real
 * list price, and it prices the rule currently being edited — before it is saved.
 *
 * It also shows what did NOT apply and why. "My weekend rule didn't fire" is the
 * single most common pricing support question, and the answer is almost always
 * that a more specific rule beat it. Saying so on screen removes the mystery.
 */

// ===========================================================================
// Types shared with the page's server actions
// ===========================================================================

export type RuleKind =
  | 'SEASONAL'
  | 'WEEKEND'
  | 'TIME_OF_DAY'
  | 'LEAD_TIME'
  | 'DEMAND'
  | 'GUIDE_MARKUP';

export type AdjustmentType = 'PERCENT' | 'FLAT';

/** The wire shape for creating/updating a rule. Dates travel as ISO strings. */
export interface PricingRuleDraft {
  name: string;
  kind: RuleKind;
  adjustmentType: AdjustmentType;
  /** PERCENT: whole percent. FLAT: integer cents. */
  adjustmentValue: number;
  isActive: boolean;
  activityId: string | null;
  rateId: string | null;
  startsOn: string | null;
  endsOn: string | null;
  weekdays: number[];
  startMinute: number | null;
  endMinute: number | null;
  minLeadMinutes: number | null;
  maxLeadMinutes: number | null;
  demandThreshold: number | null;
}

export interface PricingRuleRow extends PricingRuleDraft {
  id: string;
  priority: number;
}

export interface RateOption {
  id: string;
  name: string;
  priceCents: number;
}

export interface ActivityOption {
  id: string;
  name: string;
  rates: RateOption[];
}

export interface ActionResult {
  ok: boolean;
  message?: string;
}

export interface PreviewPayload {
  activityId: string;
  rateId: string;
  /** ISO string for the slot's start. */
  slotStart: string;
  /** ISO string for when the booking is made (drives lead-time rules). */
  bookingAt: string;
  capacityTotal: number;
  capacityBooked: number;
  /** An unsaved rule to price alongside the stored ones, or null. */
  draftRule: (PricingRuleDraft & { id: string }) | null;
  /** When editing, the stored rule the draft replaces. */
  replacesRuleId: string | null;
}

export interface PreviewAdjustment {
  ruleId: string;
  name: string;
  kind: RuleKind;
  deltaCents: number;
}

export interface PreviewSuppressed {
  ruleId: string;
  name: string;
  kind: RuleKind;
  reason: 'LESS_SPECIFIC_SCOPE' | 'LOWER_PRECEDENCE';
  supersededBy: string;
}

export interface PreviewOutcome {
  ok: boolean;
  message?: string;
  result?: {
    activityName: string;
    rateName: string;
    basePriceCents: number;
    priceCents: number;
    rawPriceCents: number;
    floorCents: number;
    ceilingCents: number;
    clampedBy: 'NONE' | 'FLOOR' | 'CEILING';
    applied: PreviewAdjustment[];
    suppressed: PreviewSuppressed[];
  };
}

export interface PricingRulesProps {
  rules: PricingRuleRow[];
  activities: ActivityOption[];
  /** Kinds this deployment's schema can store. Others can be previewed only. */
  persistableKinds: RuleKind[];
  onCreate: (input: PricingRuleDraft) => Promise<ActionResult>;
  onUpdate: (id: string, input: PricingRuleDraft) => Promise<ActionResult>;
  onDelete: (id: string) => Promise<ActionResult>;
  onToggle: (id: string, isActive: boolean) => Promise<ActionResult>;
  onReorder: (orderedIds: string[]) => Promise<ActionResult>;
  onPreview: (input: PreviewPayload) => Promise<PreviewOutcome>;
}

// ===========================================================================
// Labels + small helpers
// ===========================================================================

const KIND_LABEL: Record<RuleKind, string> = {
  SEASONAL: 'Season (date range)',
  WEEKEND: 'Day of week',
  TIME_OF_DAY: 'Time of day',
  LEAD_TIME: 'Lead time',
  DEMAND: 'Demand / occupancy',
  GUIDE_MARKUP: 'Guided surcharge',
};

const KIND_HINT: Record<RuleKind, string> = {
  SEASONAL: 'Applies between two dates — your high season.',
  WEEKEND: 'Applies on the days you pick. Defaults to Saturday and Sunday.',
  TIME_OF_DAY: 'Applies to slots starting inside a time window — the sunset premium.',
  LEAD_TIME: 'Applies by how far ahead the booking is made — last-minute or early-bird.',
  DEMAND: 'Applies once a slot is a given share full.',
  GUIDE_MARKUP: 'Always applies to the rates it is scoped to.',
};

/** Order rules are evaluated in. One rule per kind wins; they then stack on the base price. */
const KIND_ORDER: RuleKind[] = [
  'SEASONAL',
  'WEEKEND',
  'TIME_OF_DAY',
  'LEAD_TIME',
  'DEMAND',
  'GUIDE_MARKUP',
];

const WEEKDAYS: Array<{ iso: number; label: string }> = [
  { iso: 1, label: 'Mon' },
  { iso: 2, label: 'Tue' },
  { iso: 3, label: 'Wed' },
  { iso: 4, label: 'Thu' },
  { iso: 5, label: 'Fri' },
  { iso: 6, label: 'Sat' },
  { iso: 7, label: 'Sun' },
];

const SUPPRESSION_LABEL: Record<PreviewSuppressed['reason'], string> = {
  LESS_SPECIFIC_SCOPE: 'a more specific rule covers this rate',
  LOWER_PRECEDENCE: 'a higher-priority rule of the same type won',
};

/** "+15%" / "-$25.00" — how an adjustment reads in a list. */
function describeAdjustment(type: AdjustmentType, value: number): string {
  if (type === 'PERCENT') return `${value > 0 ? '+' : ''}${value}%`;
  return `${value < 0 ? '-' : '+'}${formatUSD(Math.abs(value))}`;
}

/** Signed money for a breakdown row: "+$44.85". */
function signedUSD(cents: number): string {
  return `${cents < 0 ? '-' : '+'}${formatUSD(Math.abs(cents))}`;
}

/** 1050 -> "17:30" for an <input type="time">. */
function minutesToTimeValue(minutes: number | null): string {
  if (minutes == null) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "17:30" -> 1050. */
function timeValueToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number.isFinite(minutes) ? minutes : null;
}

/** ISO date-only string for an <input type="date">. */
function toDateValue(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

/** A local wall-clock date+time pair -> an ISO instant. */
function toIso(dateValue: string, timeValue: string): string | null {
  if (!dateValue) return null;
  const [y, m, d] = dateValue.split('-').map(Number);
  const minutes = timeValueToMinutes(timeValue || '00:00') ?? 0;
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60).toISOString();
}

/** Today, as the default preview date. */
function todayValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

function emptyDraft(): PricingRuleDraft {
  return {
    name: '',
    kind: 'SEASONAL',
    adjustmentType: 'PERCENT',
    adjustmentValue: 15,
    isActive: true,
    activityId: null,
    rateId: null,
    startsOn: null,
    endsOn: null,
    weekdays: [],
    startMinute: null,
    endMinute: null,
    minLeadMinutes: null,
    maxLeadMinutes: null,
    demandThreshold: null,
  };
}

// ===========================================================================
// The page-level component
// ===========================================================================

export function PricingRules({
  rules,
  activities,
  persistableKinds,
  onCreate,
  onUpdate,
  onDelete,
  onToggle,
  onReorder,
  onPreview,
}: PricingRulesProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<PricingRuleDraft>(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const ordered = useMemo(
    () => [...rules].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1)),
    [rules],
  );

  const isEditing = creating || editingId != null;

  function beginCreate() {
    setDraft(emptyDraft());
    setEditingId(null);
    setCreating(true);
    setError(null);
  }

  function beginEdit(row: PricingRuleRow) {
    const { id: _id, priority: _priority, ...rest } = row;
    setDraft({ ...rest });
    setCreating(false);
    setEditingId(row.id);
    setError(null);
  }

  function cancel() {
    setCreating(false);
    setEditingId(null);
    setError(null);
  }

  function run(action: () => Promise<ActionResult>, fallback: string) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.message ?? fallback);
    });
  }

  function save() {
    setError(null);
    const id = editingId;
    startTransition(async () => {
      const result = id != null ? await onUpdate(id, draft) : await onCreate(draft);
      if (result.ok) {
        setCreating(false);
        setEditingId(null);
        return;
      }
      setError(result.message ?? 'Could not save the rule.');
    });
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= ordered.length) return;
    const next = [...ordered];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    run(() => onReorder(next.map((r) => r.id)), 'Could not reorder the rules.');
  }

  const scopeLabel = (row: PricingRuleDraft): string => {
    if (row.rateId) {
      for (const activity of activities) {
        const rate = activity.rates.find((r) => r.id === row.rateId);
        if (rate) return `${activity.name} · ${rate.name}`;
      }
      return 'One rate';
    }
    if (row.activityId) {
      return activities.find((a) => a.id === row.activityId)?.name ?? 'One activity';
    }
    return 'All activities';
  };

  return (
    <div className="flex flex-col gap-6">
      <PrecedenceNote />

      <SettingsCard
        title="Pricing rules"
        description="Charge what a slot is worth. Rules are grouped by type — one rule of each type applies to a booking, and the winners stack on the rate's list price."
        footer={
          !isEditing ? (
            <PrimaryButton type="button" onClick={beginCreate} disabled={isPending}>
              <Plus className="h-4 w-4" aria-hidden /> Add rule
            </PrimaryButton>
          ) : undefined
        }
      >
        {error ? (
          <p role="alert" className="mb-3 text-sm font-medium text-rose-700">
            {error}
          </p>
        ) : null}

        {isEditing ? (
          <RuleEditor
            draft={draft}
            setDraft={setDraft}
            activities={activities}
            persistableKinds={persistableKinds}
            onSave={save}
            onCancel={cancel}
            isPending={isPending}
          />
        ) : null}

        {ordered.length === 0 && !isEditing ? (
          <div className="rounded-lg border border-dashed border-line-strong bg-surface p-8 text-center text-sm text-ink-body">
            No pricing rules yet. Every booking is charged the rate's list price.
          </div>
        ) : (
          <ol className="divide-y divide-line">
            {ordered.map((row, index) => (
              <li key={row.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{row.name}</span>
                    <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-body">
                      {KIND_LABEL[row.kind]}
                    </span>
                    <span className="text-sm font-semibold text-ink">
                      {describeAdjustment(row.adjustmentType, row.adjustmentValue)}
                    </span>
                    {!row.isActive ? (
                      <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-body">
                        Disabled
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-body">
                    Priority {index + 1} · {scopeLabel(row)} · {summarizeCondition(row)}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={isPending || index === 0}
                    aria-label={`Move ${row.name} up`}
                    className="rounded-md p-1.5 text-ink-body hover:bg-surface-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={isPending || index === ordered.length - 1}
                    aria-label={`Move ${row.name} down`}
                    className="rounded-md p-1.5 text-ink-body hover:bg-surface-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      run(() => onToggle(row.id, !row.isActive), 'Could not update the rule.')
                    }
                    disabled={isPending}
                    className="rounded-md px-2 py-1 text-xs font-medium text-ink-body hover:bg-surface-muted"
                  >
                    {row.isActive ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    onClick={() => beginEdit(row)}
                    disabled={isPending}
                    aria-label={`Edit ${row.name}`}
                    className="rounded-md p-1.5 text-ink-body hover:bg-surface-muted hover:text-ink"
                  >
                    <Pencil className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => run(() => onDelete(row.id), 'Could not delete the rule.')}
                    disabled={isPending}
                    aria-label={`Delete ${row.name}`}
                    className="rounded-md p-1.5 text-rose-600 hover:bg-rose-50"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </SettingsCard>

      <PricePreview
        activities={activities}
        onPreview={onPreview}
        draftRule={isEditing ? draft : null}
        replacesRuleId={editingId}
      />
    </div>
  );
}

/** One-paragraph statement of the stacking contract, in the operator's words. */
function PrecedenceNote() {
  return (
    <section
      aria-labelledby="pricing-precedence-heading"
      className="rounded-lg border border-line bg-surface p-5 shadow-sm"
    >
      <h2 id="pricing-precedence-heading" className="text-base font-semibold text-ink">
        How rules combine
      </h2>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink-body">
        <li>Only enabled rules that match the booking are considered.</li>
        <li>
          Within a type, the most specific one wins — a rule on one rate beats one on the
          activity, which beats one on everything.
        </li>
        <li>
          Still tied? The higher priority (nearer the top of the list) wins. Exactly one rule of
          each type applies.
        </li>
        <li>
          The winners are added up against the <strong>list price</strong>, not against each
          other: +20% and +10% is +30%, never +32%.
        </li>
        <li>The result is capped between a floor and a ceiling so no stack can go absurd.</li>
      </ol>
    </section>
  );
}

/** The plain-English condition shown under a rule in the list. */
function summarizeCondition(row: PricingRuleDraft): string {
  switch (row.kind) {
    case 'SEASONAL': {
      const from = row.startsOn ? toDateValue(row.startsOn) : 'any date';
      const to = row.endsOn ? toDateValue(row.endsOn) : 'onwards';
      return `${from} → ${to}`;
    }
    case 'WEEKEND': {
      const days = row.weekdays.length > 0 ? row.weekdays : [6, 7];
      return days
        .slice()
        .sort((a, b) => a - b)
        .map((d) => WEEKDAYS.find((w) => w.iso === d)?.label ?? String(d))
        .join(', ');
    }
    case 'TIME_OF_DAY':
      return `${minutesToTimeValue(row.startMinute) || '--:--'} → ${
        minutesToTimeValue(row.endMinute) || '--:--'
      }`;
    case 'LEAD_TIME': {
      const parts: string[] = [];
      if (row.minLeadMinutes != null) parts.push(`${Math.round(row.minLeadMinutes / 60)}h or more ahead`);
      if (row.maxLeadMinutes != null) parts.push(`${Math.round(row.maxLeadMinutes / 60)}h or less ahead`);
      return parts.join(' and ') || 'no window set';
    }
    case 'DEMAND':
      return row.demandThreshold != null
        ? `${Math.round(row.demandThreshold * 100)}% booked or more`
        : 'no threshold set';
    case 'GUIDE_MARKUP':
      return 'always applies';
  }
}

// ===========================================================================
// Editor
// ===========================================================================

function RuleEditor({
  draft,
  setDraft,
  activities,
  persistableKinds,
  onSave,
  onCancel,
  isPending,
}: {
  draft: PricingRuleDraft;
  setDraft: (d: PricingRuleDraft) => void;
  activities: ActivityOption[];
  persistableKinds: RuleKind[];
  onSave: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const uid = useId();
  const activity = activities.find((a) => a.id === draft.activityId) ?? null;
  const kindSupported = persistableKinds.includes(draft.kind);

  const set = (patch: Partial<PricingRuleDraft>) => setDraft({ ...draft, ...patch });

  /** Switching kind clears the other kinds' fields so a stale window can't linger. */
  function setKind(kind: RuleKind) {
    set({
      kind,
      startsOn: kind === 'SEASONAL' ? draft.startsOn : null,
      endsOn: kind === 'SEASONAL' ? draft.endsOn : null,
      weekdays: kind === 'WEEKEND' ? draft.weekdays : [],
      startMinute: kind === 'TIME_OF_DAY' ? draft.startMinute : null,
      endMinute: kind === 'TIME_OF_DAY' ? draft.endMinute : null,
      minLeadMinutes: kind === 'LEAD_TIME' ? draft.minLeadMinutes : null,
      maxLeadMinutes: kind === 'LEAD_TIME' ? draft.maxLeadMinutes : null,
      demandThreshold: kind === 'DEMAND' ? draft.demandThreshold : null,
    });
  }

  function toggleWeekday(iso: number) {
    const next = draft.weekdays.includes(iso)
      ? draft.weekdays.filter((d) => d !== iso)
      : [...draft.weekdays, iso];
    set({ weekdays: next.sort((a, b) => a - b) });
  }

  const amountValue =
    draft.adjustmentType === 'PERCENT' ? draft.adjustmentValue : draft.adjustmentValue / 100;

  return (
    <div className="mb-5 rounded-lg border border-line bg-surface-muted p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Rule name" htmlFor={`${uid}-name`} required>
          <TextInput
            id={`${uid}-name`}
            value={draft.name}
            placeholder="e.g. Summer weekends"
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>

        <Field label="When it applies" htmlFor={`${uid}-kind`} hint={KIND_HINT[draft.kind]}>
          <Select
            id={`${uid}-kind`}
            value={draft.kind}
            onChange={(e) => setKind(e.target.value as RuleKind)}
          >
            {KIND_ORDER.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Adjustment" htmlFor={`${uid}-adjustment-type`}>
          <Select
            id={`${uid}-adjustment-type`}
            value={draft.adjustmentType}
            onChange={(e) => {
              const type = e.target.value as AdjustmentType;
              // Keep the magnitude sane across the switch: 15% -> $15.00, not 15c.
              set({
                adjustmentType: type,
                adjustmentValue:
                  type === 'FLAT' ? draft.adjustmentValue * 100 : Math.round(draft.adjustmentValue / 100),
              });
            }}
          >
            <option value="PERCENT">Percent of the list price</option>
            <option value="FLAT">Flat amount (USD)</option>
          </Select>
        </Field>

        <Field
          label={draft.adjustmentType === 'PERCENT' ? 'Percent change' : 'Amount change (USD)'}
          htmlFor={`${uid}-adjustment-value`}
          required
          hint="Negative is a discount — for example -20 for a last-minute deal."
        >
          <TextInput
            id={`${uid}-adjustment-value`}
            type="number"
            step={draft.adjustmentType === 'PERCENT' ? 1 : 0.01}
            value={Number.isNaN(amountValue) ? '' : amountValue}
            onChange={(e) => {
              const raw = e.target.valueAsNumber;
              set({
                adjustmentValue: Number.isNaN(raw)
                  ? 0
                  : draft.adjustmentType === 'PERCENT'
                    ? Math.round(raw)
                    : Math.round(raw * 100),
              });
            }}
          />
        </Field>

        <Field label="Applies to" htmlFor={`${uid}-activity`} hint="Narrow it to one activity, or leave it on everything.">
          <Select
            id={`${uid}-activity`}
            value={draft.activityId ?? ''}
            onChange={(e) => set({ activityId: e.target.value || null, rateId: null })}
          >
            <option value="">All activities</option>
            {activities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Rate"
          htmlFor={`${uid}-rate`}
          hint={activity ? 'A rule on one rate beats a rule on the whole activity.' : 'Pick an activity first.'}
        >
          <Select
            id={`${uid}-rate`}
            value={draft.rateId ?? ''}
            disabled={!activity}
            onChange={(e) => set({ rateId: e.target.value || null })}
          >
            <option value="">All rates</option>
            {(activity?.rates ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} — {formatUSD(r.priceCents)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <KindFields draft={draft} set={set} toggleWeekday={toggleWeekday} uid={uid} />

      <div className="mt-3">
        <CheckboxRow
          label="Enabled"
          description="Apply this rule to new bookings."
          checked={draft.isActive}
          onChange={(e) => set({ isActive: e.target.checked })}
        />
      </div>

      {!kindSupported ? (
        <p role="alert" className="mt-3 text-sm font-medium text-amber-800">
          “{KIND_LABEL[draft.kind]}” rules can be previewed but not saved on this deployment yet —
          the database needs the pricing-rule window migration.
        </p>
      ) : null}

      <div className="mt-4 flex items-center justify-end gap-2">
        <SecondaryButton type="button" onClick={onCancel} disabled={isPending}>
          <X className="h-4 w-4" aria-hidden /> Cancel
        </SecondaryButton>
        <PrimaryButton type="button" onClick={onSave} disabled={isPending}>
          <Check className="h-4 w-4" aria-hidden /> {isPending ? 'Saving…' : 'Save rule'}
        </PrimaryButton>
      </div>
    </div>
  );
}

/** The condition fields for whichever kind is selected. */
function KindFields({
  draft,
  set,
  toggleWeekday,
  uid,
}: {
  draft: PricingRuleDraft;
  set: (patch: Partial<PricingRuleDraft>) => void;
  toggleWeekday: (iso: number) => void;
  uid: string;
}) {
  if (draft.kind === 'GUIDE_MARKUP') {
    return (
      <p className="mt-4 text-sm text-ink-body">
        This rule always applies to the rates above. Scope it to a guided rate so it does not
        surcharge everything.
      </p>
    );
  }

  if (draft.kind === 'SEASONAL') {
    return (
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Season starts" htmlFor={`${uid}-starts`} hint="Leave blank for no start date.">
          <TextInput
            id={`${uid}-starts`}
            type="date"
            value={toDateValue(draft.startsOn)}
            onChange={(e) => set({ startsOn: toIso(e.target.value, '00:00') })}
          />
        </Field>
        <Field label="Season ends" htmlFor={`${uid}-ends`} hint="Inclusive. Leave blank for open-ended.">
          <TextInput
            id={`${uid}-ends`}
            type="date"
            value={toDateValue(draft.endsOn)}
            onChange={(e) => set({ endsOn: toIso(e.target.value, '00:00') })}
          />
        </Field>
      </div>
    );
  }

  if (draft.kind === 'WEEKEND') {
    const selected = draft.weekdays.length > 0 ? draft.weekdays : [6, 7];
    return (
      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-ink-body">Days it applies</legend>
        <p className="mt-0.5 text-xs text-ink-body">Nothing selected means Saturday and Sunday.</p>
        <div className="mt-2 flex flex-wrap gap-3">
          {WEEKDAYS.map((day) => (
            <label
              key={day.iso}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink hover:bg-surface-muted"
            >
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-line-strong text-accent accent-accent focus:ring-focus"
                checked={selected.includes(day.iso)}
                onChange={() => toggleWeekday(day.iso)}
              />
              {day.label}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  if (draft.kind === 'TIME_OF_DAY') {
    return (
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="From" htmlFor={`${uid}-from`} required>
          <TextInput
            id={`${uid}-from`}
            type="time"
            value={minutesToTimeValue(draft.startMinute)}
            onChange={(e) => set({ startMinute: timeValueToMinutes(e.target.value) })}
          />
        </Field>
        <Field
          label="Until"
          htmlFor={`${uid}-until`}
          required
          hint="An end before the start wraps past midnight."
        >
          <TextInput
            id={`${uid}-until`}
            type="time"
            value={minutesToTimeValue(draft.endMinute)}
            onChange={(e) => set({ endMinute: timeValueToMinutes(e.target.value) })}
          />
        </Field>
      </div>
    );
  }

  if (draft.kind === 'LEAD_TIME') {
    const toHours = (m: number | null) => (m == null ? '' : Math.round(m / 60));
    const fromHours = (raw: number) => (Number.isNaN(raw) ? null : Math.max(0, Math.round(raw)) * 60);
    return (
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field
          label="Booked at least this many hours ahead"
          htmlFor={`${uid}-minlead`}
          hint="The early-bird side. Leave blank for no minimum."
        >
          <TextInput
            id={`${uid}-minlead`}
            type="number"
            min={0}
            step={1}
            value={toHours(draft.minLeadMinutes)}
            onChange={(e) => set({ minLeadMinutes: fromHours(e.target.valueAsNumber) })}
          />
        </Field>
        <Field
          label="Booked at most this many hours ahead"
          htmlFor={`${uid}-maxlead`}
          hint="The last-minute side. Leave blank for no maximum."
        >
          <TextInput
            id={`${uid}-maxlead`}
            type="number"
            min={0}
            step={1}
            value={toHours(draft.maxLeadMinutes)}
            onChange={(e) => set({ maxLeadMinutes: fromHours(e.target.valueAsNumber) })}
          />
        </Field>
      </div>
    );
  }

  // DEMAND
  const percent = draft.demandThreshold == null ? '' : Math.round(draft.demandThreshold * 100);
  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <Field
        label="Applies once the slot is this full (%)"
        htmlFor={`${uid}-demand`}
        required
        hint="80 means the rule kicks in when 80% of the seats are sold."
      >
        <TextInput
          id={`${uid}-demand`}
          type="number"
          min={0}
          max={100}
          step={1}
          value={percent}
          onChange={(e) => {
            const raw = e.target.valueAsNumber;
            set({
              demandThreshold: Number.isNaN(raw) ? null : Math.min(100, Math.max(0, raw)) / 100,
            });
          }}
        />
      </Field>
    </div>
  );
}

// ===========================================================================
// Preview
// ===========================================================================

function PricePreview({
  activities,
  onPreview,
  draftRule,
  replacesRuleId,
}: {
  activities: ActivityOption[];
  onPreview: (input: PreviewPayload) => Promise<PreviewOutcome>;
  draftRule: PricingRuleDraft | null;
  replacesRuleId: string | null;
}) {
  const uid = useId();
  const firstActivity = activities[0] ?? null;

  const [activityId, setActivityId] = useState(firstActivity?.id ?? '');
  const [rateId, setRateId] = useState(firstActivity?.rates[0]?.id ?? '');
  const [date, setDate] = useState(todayValue());
  const [time, setTime] = useState('17:30');
  const [bookingDate, setBookingDate] = useState(todayValue());
  const [bookingTime, setBookingTime] = useState('09:00');
  const [capacityTotal, setCapacityTotal] = useState(10);
  const [capacityBooked, setCapacityBooked] = useState(8);
  const [includeDraft, setIncludeDraft] = useState(true);
  const [outcome, setOutcome] = useState<PreviewOutcome | null>(null);
  const [isPending, startTransition] = useTransition();

  const activity = activities.find((a) => a.id === activityId) ?? null;
  const rates = activity?.rates ?? [];

  function runPreview() {
    const slotStart = toIso(date, time);
    const bookingAt = toIso(bookingDate, bookingTime);
    if (!slotStart || !bookingAt || !activityId || !rateId) {
      setOutcome({ ok: false, message: 'Pick an activity, a rate, and a date to preview.' });
      return;
    }
    const payload: PreviewPayload = {
      activityId,
      rateId,
      slotStart,
      bookingAt,
      capacityTotal,
      capacityBooked,
      draftRule:
        includeDraft && draftRule ? { ...draftRule, id: replacesRuleId ?? 'draft' } : null,
      replacesRuleId,
    };
    startTransition(async () => {
      setOutcome(await onPreview(payload));
    });
  }

  const result = outcome?.result;

  return (
    <SettingsCard
      title="Preview a price"
      description="The same calculation a real booking runs, against this rate's real list price. Change the date, the occupancy or the rule above and watch the number move."
      footer={
        <PrimaryButton type="button" onClick={runPreview} disabled={isPending || !rateId}>
          {isPending ? 'Pricing…' : 'Preview price'}
        </PrimaryButton>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Activity" htmlFor={`${uid}-activity`}>
          <Select
            id={`${uid}-activity`}
            value={activityId}
            onChange={(e) => {
              const next = activities.find((a) => a.id === e.target.value) ?? null;
              setActivityId(e.target.value);
              setRateId(next?.rates[0]?.id ?? '');
            }}
          >
            {activities.length === 0 ? <option value="">No activities yet</option> : null}
            {activities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Rate" htmlFor={`${uid}-rate`}>
          <Select id={`${uid}-rate`} value={rateId} onChange={(e) => setRateId(e.target.value)}>
            {rates.length === 0 ? <option value="">No rates on this activity</option> : null}
            {rates.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} — {formatUSD(r.priceCents)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Trip date" htmlFor={`${uid}-date`}>
          <TextInput
            id={`${uid}-date`}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>

        <Field label="Trip start time" htmlFor={`${uid}-time`}>
          <TextInput
            id={`${uid}-time`}
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </Field>

        <Field label="Booked on" htmlFor={`${uid}-bookingdate`} hint="Drives lead-time rules.">
          <TextInput
            id={`${uid}-bookingdate`}
            type="date"
            value={bookingDate}
            onChange={(e) => setBookingDate(e.target.value)}
          />
        </Field>

        <Field label="Booked at" htmlFor={`${uid}-bookingtime`}>
          <TextInput
            id={`${uid}-bookingtime`}
            type="time"
            value={bookingTime}
            onChange={(e) => setBookingTime(e.target.value)}
          />
        </Field>

        <Field label="Seats on the boat" htmlFor={`${uid}-total`}>
          <TextInput
            id={`${uid}-total`}
            type="number"
            min={0}
            step={1}
            value={capacityTotal}
            onChange={(e) =>
              setCapacityTotal(Number.isNaN(e.target.valueAsNumber) ? 0 : e.target.valueAsNumber)
            }
          />
        </Field>

        <Field label="Seats already sold" htmlFor={`${uid}-booked`} hint="Drives demand rules.">
          <TextInput
            id={`${uid}-booked`}
            type="number"
            min={0}
            step={1}
            value={capacityBooked}
            onChange={(e) =>
              setCapacityBooked(Number.isNaN(e.target.valueAsNumber) ? 0 : e.target.valueAsNumber)
            }
          />
        </Field>
      </div>

      {draftRule ? (
        <div className="mt-4">
          <CheckboxRow
            label="Include the rule I'm editing"
            description="Price the unsaved rule alongside the saved ones, so you can see it before you commit."
            checked={includeDraft}
            onChange={(e) => setIncludeDraft(e.target.checked)}
          />
        </div>
      ) : null}

      <div aria-live="polite" className="mt-5">
        {outcome && !outcome.ok ? (
          <p role="alert" className="text-sm font-medium text-rose-700">
            {outcome.message ?? 'Could not price that combination.'}
          </p>
        ) : null}

        {result ? (
          <div className="rounded-lg border border-line bg-surface p-4">
            <p className="text-sm text-ink-body">
              {result.activityName} · {result.rateName}
            </p>

            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-ink-body">List price</dt>
                <dd className="font-medium text-ink tabular-nums">
                  {formatUSD(result.basePriceCents)}
                </dd>
              </div>

              {result.applied.map((adjustment) => (
                <div
                  key={adjustment.ruleId}
                  className="flex items-baseline justify-between gap-4"
                >
                  <dt className="text-ink-body">
                    {adjustment.name}{' '}
                    <span className="text-xs text-ink-body">
                      ({KIND_LABEL[adjustment.kind]})
                    </span>
                  </dt>
                  <dd className="font-medium text-ink tabular-nums">
                    {signedUSD(adjustment.deltaCents)}
                  </dd>
                </div>
              ))}

              {result.applied.length === 0 ? (
                <p className="text-ink-body">No rule matches this booking — list price applies.</p>
              ) : null}

              <div className="flex items-baseline justify-between gap-4 border-t border-line pt-2">
                <dt className="font-semibold text-ink">Price per person</dt>
                <dd className="text-lg font-semibold text-ink tabular-nums">
                  {formatUSD(result.priceCents)}
                </dd>
              </div>
            </dl>

            {result.clampedBy !== 'NONE' ? (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                The rules worked out to {formatUSD(result.rawPriceCents)}, which is outside the
                safe range of {formatUSD(result.floorCents)}–{formatUSD(result.ceilingCents)}. The
                price was capped at the {result.clampedBy === 'FLOOR' ? 'floor' : 'ceiling'}.
              </p>
            ) : null}

            {result.suppressed.length > 0 ? (
              <div className="mt-4 border-t border-line pt-3">
                <h3 className="text-sm font-medium text-ink">Rules that did not apply</h3>
                <ul className="mt-1 space-y-1 text-sm text-ink-body">
                  {result.suppressed.map((s) => (
                    <li key={s.ruleId}>
                      <span className="font-medium text-ink">{s.name}</span> —{' '}
                      {SUPPRESSION_LABEL[s.reason]}.
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </SettingsCard>
  );
}
