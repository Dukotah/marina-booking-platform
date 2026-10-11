'use client';

import { useMemo, useState, useTransition } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  Field,
  TextInput,
  Select,
  PrimaryButton,
  SecondaryButton,
  SaveStatus,
  SettingsCard,
  type SaveState,
} from './fields';
import {
  updateCancellationPolicy,
  type CancellationPolicyInput,
  type ActionResult,
} from '../../app/settings/actions';

/**
 * Editor for the operator-default tiered cancellation policy
 * (Operator.cancellation_policy). It drives the SAME JSON that
 * `computeCancellationRefund` and the API's `cancelBooking` read, so what the
 * operator sets here is exactly what the refund preview + the money path apply.
 *
 * Tiers are hours-before-start -> refund %. The calculator picks the most generous
 * tier the guest has cleared, so the "Cancel 7+ days out: full refund · 1–7 days:
 * 50% · under 24h: no refund" preview is generated straight from the tier list.
 */

export interface CancellationPolicyFormValues {
  tiers: { min_hours_before: number; refund_percent: number }[];
  cancellation_fee_dollars: number;
  fee_scope: 'order' | 'guest';
  self_cancel_hours: number;
  refund_method: 'card' | 'gift_card' | 'card_then_gift';
}

interface TierRow {
  /** Stable key for React; the values are what we persist. */
  key: string;
  hours: string;
  percent: string;
}

let rowSeq = 0;
function newRow(hours = '', percent = ''): TierRow {
  rowSeq += 1;
  return { key: `tier-${rowSeq}`, hours, percent };
}

/** "7 days", "1 day", "24 hours", "right up to start" — human hours phrasing. */
function describeHours(hours: number): string {
  if (hours <= 0) return 'right up to start time';
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? '1 day out' : `${days} days out`;
  }
  return hours === 1 ? '1 hour out' : `${hours} hours out`;
}

function describePercent(percent: number): string {
  if (percent >= 100) return 'full refund';
  if (percent <= 0) return 'no refund';
  return `${percent}% refund`;
}

/**
 * Plain-language preview built from the current (valid) tiers, sorted
 * most-generous-first, e.g. "Cancel 7+ days out: full refund · 1–7 days: 50% ·
 * under 24h: no refund".
 */
function buildPreview(rows: TierRow[]): string {
  const tiers = rows
    .map((r) => ({ hours: Number(r.hours), percent: Number(r.percent) }))
    .filter((t) => Number.isFinite(t.hours) && Number.isFinite(t.percent) && tierOk(t))
    .sort((a, b) => b.hours - a.hours);
  if (tiers.length === 0) return 'Add a tier to see the plain-language summary.';

  const parts: string[] = [];
  for (let i = 0; i < tiers.length; i += 1) {
    const t = tiers[i];
    const next = tiers[i + 1];
    if (i === 0) {
      parts.push(`Cancel ${describeHours(t.hours).replace(' out', '+ out')}: ${describePercent(t.percent)}`);
    } else {
      parts.push(`${describeHours(t.hours)}: ${describePercent(t.percent)}`);
    }
    // Anything earlier than the last (least-generous) tier gets the implicit 0%.
    if (!next && t.hours > 0) {
      parts.push(`under ${t.hours}h: no refund`);
    }
  }
  return parts.join(' · ');
}

function tierOk(t: { hours: number; percent: number }): boolean {
  return t.hours >= 0 && t.percent >= 0 && t.percent <= 100;
}

const FEE_SCOPES = [
  { value: 'order', label: 'Once per order' },
  { value: 'guest', label: 'Per guest' },
] as const;

const REFUND_METHODS = [
  { value: 'card', label: 'Back to card' },
  { value: 'gift_card', label: 'Gift card credit' },
  { value: 'card_then_gift', label: 'Card first, then gift card' },
] as const;

export function CancellationPolicyForm({ initial }: { initial: CancellationPolicyFormValues }) {
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [rows, setRows] = useState<TierRow[]>(() =>
    initial.tiers.length > 0
      ? initial.tiers.map((t) => newRow(String(t.min_hours_before), String(t.refund_percent)))
      : [newRow('168', '100'), newRow('24', '50'), newRow('0', '0')],
  );
  const [fee, setFee] = useState<string>(String(initial.cancellation_fee_dollars));
  const [feeScope, setFeeScope] = useState<'order' | 'guest'>(initial.fee_scope);
  const [selfCancelHours, setSelfCancelHours] = useState<string>(String(initial.self_cancel_hours));
  const [refundMethod, setRefundMethod] = useState<
    'card' | 'gift_card' | 'card_then_gift'
  >(initial.refund_method);

  const preview = useMemo(() => buildPreview(rows), [rows]);

  function setRow(key: string, patch: Partial<TierRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, newRow()]);
  }
  function removeRow(key: string) {
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));
  }

  function onSubmit() {
    setSaveState({ kind: 'idle' });
    setFormError(null);

    const parsedTiers = rows.map((r) => ({
      min_hours_before: Number(r.hours),
      refund_percent: Number(r.percent),
    }));
    if (parsedTiers.some((t) => !Number.isFinite(t.min_hours_before) || !Number.isFinite(t.refund_percent))) {
      setFormError('Every tier needs a whole number of hours and a refund percent.');
      return;
    }

    const payload: CancellationPolicyInput = {
      tiers: parsedTiers,
      cancellation_fee_dollars: Number(fee) || 0,
      fee_scope: feeScope,
      self_cancel_hours: Number(selfCancelHours) || 0,
      refund_method: refundMethod,
    };

    startTransition(async () => {
      const result: ActionResult = await updateCancellationPolicy(payload);
      if (result.ok) {
        setSaveState({ kind: 'saved' });
        return;
      }
      const firstError = result.errors ? Object.values(result.errors)[0] : undefined;
      setSaveState({
        kind: 'error',
        message: result.message ?? firstError ?? 'Could not save the cancellation policy.',
      });
    });
  }

  const rowInput =
    'h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus';

  return (
    <SettingsCard
      title="Cancellation & refunds"
      description="The refund rules staff and guests see when a booking is cancelled. The earlier a guest cancels, the more they get back."
    >
      <div className="space-y-6">
        {/* Tiers */}
        <div>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-ink">Refund tiers</h3>
            <SecondaryButton onClick={addRow} className="min-h-11">
              <Plus className="h-4 w-4" aria-hidden /> Add tier
            </SecondaryButton>
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            Each tier is “cancel at least this many hours before the start → refund this percent.”
          </p>

          <ul className="mt-3 space-y-2">
            {rows.map((r) => (
              <li
                key={r.key}
                className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface-muted p-3"
              >
                <label className="text-xs font-medium text-ink-body">
                  Hours before start
                  <input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={r.hours}
                    onChange={(e) => setRow(r.key, { hours: e.target.value })}
                    placeholder="24"
                    className={`mt-0.5 ${rowInput} w-28`}
                    aria-label="Hours before start"
                  />
                </label>
                <span className="pb-3 text-ink-muted">→</span>
                <label className="text-xs font-medium text-ink-body">
                  Refund percent
                  <div className="mt-0.5 flex items-center">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      inputMode="numeric"
                      value={r.percent}
                      onChange={(e) => setRow(r.key, { percent: e.target.value })}
                      placeholder="50"
                      className={`${rowInput} w-24 rounded-r-none`}
                      aria-label="Refund percent"
                    />
                    <span className="inline-flex h-11 items-center rounded-r-lg border border-l-0 border-line bg-surface px-2.5 text-sm text-ink-muted">
                      %
                    </span>
                  </div>
                </label>
                <button
                  type="button"
                  onClick={() => removeRow(r.key)}
                  disabled={rows.length <= 1}
                  aria-label="Remove this tier"
                  className="ml-auto inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink-muted hover:bg-surface hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Fee + scope + self-cancel + method */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Cancellation fee"
            htmlFor="cancellation_fee"
            hint="A flat amount withheld from the refund. Set 0 for none."
          >
            <div className="flex items-center rounded-lg border border-line bg-surface px-3 focus-within:border-accent focus-within:ring-2 focus-within:ring-focus">
              <span className="text-ink-muted">$</span>
              <input
                id="cancellation_fee"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={fee}
                onChange={(e) => setFee(e.target.value)}
                placeholder="0.00"
                className="h-11 w-full border-0 bg-transparent pl-1 text-sm text-ink focus:outline-none focus:ring-0"
              />
            </div>
          </Field>

          <Field label="Fee applies" htmlFor="fee_scope">
            <Select
              id="fee_scope"
              value={feeScope}
              onChange={(e) => setFeeScope(e.target.value as 'order' | 'guest')}
            >
              {FEE_SCOPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Guests can self-cancel until"
            htmlFor="self_cancel_hours"
            hint="Hours before start a guest may cancel themselves online. Staff can always cancel."
          >
            <div className="flex items-center">
              <TextInput
                id="self_cancel_hours"
                type="number"
                min={0}
                inputMode="numeric"
                value={selfCancelHours}
                onChange={(e) => setSelfCancelHours(e.target.value)}
                placeholder="24"
                className="rounded-r-none"
              />
              <span className="inline-flex h-11 items-center rounded-r-lg border border-l-0 border-line bg-surface px-3 text-sm text-ink-muted">
                hours
              </span>
            </div>
          </Field>

          <Field label="Refund method" htmlFor="refund_method">
            <Select
              id="refund_method"
              value={refundMethod}
              onChange={(e) =>
                setRefundMethod(e.target.value as 'card' | 'gift_card' | 'card_then_gift')
              }
            >
              {REFUND_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {/* Plain-language preview */}
        <div className="rounded-lg border border-accent/30 bg-accent/5 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Guests will see</p>
          <p className="mt-1 text-sm text-ink">{preview}</p>
          {Number(fee) > 0 ? (
            <p className="mt-1 text-xs text-ink-body">
              Minus a ${Number(fee).toFixed(2)} fee {feeScope === 'guest' ? 'per guest' : 'per booking'}.
            </p>
          ) : null}
        </div>

        {formError ? (
          <p role="alert" className="text-sm font-medium text-rose-600">
            {formError}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-3">
          <SaveStatus state={saveState} />
          <PrimaryButton type="button" onClick={onSubmit} disabled={isPending}>
            {isPending ? 'Saving…' : 'Save cancellation policy'}
          </PrimaryButton>
        </div>
      </div>
    </SettingsCard>
  );
}
