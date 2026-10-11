'use client';

import { useId, useState, useTransition } from 'react';
import { Button, Input, Select, FieldLabel } from '../ui';
import { createMembershipAction, updateMembershipAction, type ActionResult } from './actions';

export type MembershipKind = 'SEASON_PASS' | 'PUNCH_CARD' | 'MEMBER_RATE';

export interface MembershipFormValues {
  id?: string;
  name: string;
  kind: MembershipKind;
  priceCents: number;
  discountType: 'PERCENT' | 'FLAT';
  /** PERCENT: whole percent. FLAT: integer cents. */
  discountValue: number;
  totalUses: number | null;
  durationDays: number | null;
  isActive: boolean;
}

const BLANK: MembershipFormValues = {
  name: '',
  kind: 'SEASON_PASS',
  priceCents: 0,
  discountType: 'PERCENT',
  discountValue: 10,
  totalUses: null,
  durationDays: null,
  isActive: true,
};

const KIND_HELP: Record<MembershipKind, string> = {
  SEASON_PASS: 'Unlimited member pricing for the length of the pass.',
  PUNCH_CARD: 'A fixed number of launches. One is spent per seat booked.',
  MEMBER_RATE: 'A standing member rate with no uses and no expiry.',
};

/**
 * Create / edit a membership product.
 *
 * One component for both so the two forms can never drift apart in validation or
 * in wording. Money is entered in dollars and converted to integer cents by the
 * server action (`toCents`), which is the only place that conversion happens.
 *
 * Accessibility: every control has a real <label> bound by id; the kind choice is a
 * radiogroup in a <fieldset>/<legend> so a screen reader announces what the three
 * options are choosing between; the discount unit switches the field's own label
 * (Percent off / Dollars off) rather than relying on an adjacent hint; and the
 * result line is a live region so a keyboard user who never sees the bottom of the
 * card still hears "Saved."
 */
export function MembershipForm({
  initial,
  onSaved,
}: {
  initial?: MembershipFormValues;
  /** Called after a successful save (used to close an inline editor). */
  onSaved?: () => void;
}) {
  const values = initial ?? BLANK;
  const isEdit = Boolean(values.id);
  const uid = useId();

  const [kind, setKind] = useState<MembershipKind>(values.kind);
  const [discountType, setDiscountType] = useState<'PERCENT' | 'FLAT'>(values.discountType);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const discountDefault =
    values.discountType === 'FLAT' ? (values.discountValue / 100).toFixed(2) : String(values.discountValue);

  return (
    <form
      className="rounded-lg border border-line bg-surface p-5 shadow-sm"
      action={(formData) =>
        startTransition(async () => {
          const r = isEdit
            ? await updateMembershipAction(values.id!, formData)
            : await createMembershipAction(formData);
          setResult(r);
          if (r.ok) onSaved?.();
        })
      }
    >
      <h2 className="text-base font-semibold text-ink">
        {isEdit ? 'Edit membership' : 'New membership'}
      </h2>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <FieldLabel htmlFor={`${uid}-name`}>Name</FieldLabel>
          <Input
            id={`${uid}-name`}
            name="name"
            type="text"
            required
            maxLength={160}
            defaultValue={values.name}
            placeholder="Season Pass 2026"
          />
        </div>

        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium text-ink">Type</legend>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:gap-6">
            {(Object.keys(KIND_HELP) as MembershipKind[]).map((k) => (
              <div key={k} className="flex items-start gap-2">
                <input
                  id={`${uid}-kind-${k}`}
                  name="kind"
                  type="radio"
                  value={k}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                  className="mt-1 h-4 w-4 border-line text-accent focus:ring-2 focus:ring-focus"
                />
                <label htmlFor={`${uid}-kind-${k}`} className="text-sm text-ink-body">
                  <span className="font-medium text-ink">
                    {k === 'SEASON_PASS' ? 'Season pass' : k === 'PUNCH_CARD' ? 'Punch card' : 'Member rate'}
                  </span>
                  <span className="block text-xs text-ink-muted">{KIND_HELP[k]}</span>
                </label>
              </div>
            ))}
          </div>
        </fieldset>

        <div>
          <FieldLabel htmlFor={`${uid}-price`}>Price to buy (USD)</FieldLabel>
          <Input
            id={`${uid}-price`}
            name="priceDollars"
            type="number"
            min="0"
            step="0.01"
            required
            defaultValue={(values.priceCents / 100).toFixed(2)}
          />
          <p className="mt-1 text-xs text-ink-muted">Enter 0 for a membership you only ever comp.</p>
        </div>

        <div>
          <FieldLabel htmlFor={`${uid}-discount-type`}>Member discount is</FieldLabel>
          <Select
            id={`${uid}-discount-type`}
            name="discountType"
            value={discountType}
            onChange={(e) => setDiscountType(e.target.value as 'PERCENT' | 'FLAT')}
          >
            <option value="PERCENT">A percentage off</option>
            <option value="FLAT">A dollar amount off</option>
          </Select>
        </div>

        <div>
          <FieldLabel htmlFor={`${uid}-discount`}>
            {discountType === 'PERCENT' ? 'Percent off each booking' : 'Dollars off each booking'}
          </FieldLabel>
          <Input
            id={`${uid}-discount`}
            name="discountValue"
            type="number"
            min="0"
            max={discountType === 'PERCENT' ? 100 : undefined}
            step={discountType === 'PERCENT' ? 1 : 0.01}
            required
            defaultValue={discountDefault}
          />
        </div>

        <div>
          <FieldLabel htmlFor={`${uid}-duration`}>Valid for (days)</FieldLabel>
          <Input
            id={`${uid}-duration`}
            name="durationDays"
            type="number"
            min="1"
            step="1"
            defaultValue={values.durationDays ?? ''}
          />
          <p className="mt-1 text-xs text-ink-muted">Leave blank for no expiry.</p>
        </div>

        {/*
          Only a punch card has uses. Rendering the field conditionally (rather than
          disabling it) keeps it out of the tab order and out of the accessibility
          tree entirely, so nobody tabs into a control that does nothing.
        */}
        {kind === 'PUNCH_CARD' ? (
          <div>
            <FieldLabel htmlFor={`${uid}-uses`}>Number of launches</FieldLabel>
            <Input
              id={`${uid}-uses`}
              name="totalUses"
              type="number"
              min="1"
              step="1"
              required
              defaultValue={values.totalUses ?? 10}
            />
            <p className="mt-1 text-xs text-ink-muted">One is spent per seat booked.</p>
          </div>
        ) : null}

        <div className="flex items-center gap-2 sm:col-span-2">
          <input
            id={`${uid}-active`}
            name="isActive"
            type="checkbox"
            defaultChecked={values.isActive}
            className="h-4 w-4 rounded border-line text-accent accent-accent focus:ring-2 focus:ring-focus"
          />
          <label htmlFor={`${uid}-active`} className="text-sm text-ink-body">
            For sale on the customer site
          </label>
        </div>
      </div>

      {isEdit ? (
        <p className="mt-4 rounded-lg bg-surface-muted p-3 text-xs text-ink-body">
          Changing the discount changes what current members pay from their next booking
          onward. Uses and expiry are fixed when a membership is issued, so existing
          holders keep the terms they bought.
        </p>
      ) : null}

      <div className="mt-4 flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Create membership'}
        </Button>
      </div>

      {/*
        aria-live so the outcome reaches a screen reader without moving focus; the
        error also carries role="alert" because a failed save is the one case worth
        interrupting for.
      */}
      <div aria-live="polite" className="mt-3 min-h-[1.25rem]">
        {result?.ok ? (
          <p className="text-sm text-emerald-700">{result.message ?? 'Saved.'}</p>
        ) : null}
        {result && !result.ok ? (
          <p role="alert" className="text-sm text-rose-700">
            {result.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
