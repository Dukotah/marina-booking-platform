'use client';

import { useId, useState, useTransition } from 'react';
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
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
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
      <h2 className="text-base font-semibold text-slate-900">
        {isEdit ? 'Edit membership' : 'New membership'}
      </h2>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor={`${uid}-name`} className="block text-sm font-medium text-slate-700">
            Name
          </label>
          <input
            id={`${uid}-name`}
            name="name"
            type="text"
            required
            maxLength={160}
            defaultValue={values.name}
            placeholder="Season Pass 2026"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600"
          />
        </div>

        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium text-slate-700">Type</legend>
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
                  className="mt-1 h-4 w-4 border-slate-400 text-sky-700 focus:ring-2 focus:ring-sky-600"
                />
                <label htmlFor={`${uid}-kind-${k}`} className="text-sm text-slate-700">
                  <span className="font-medium text-slate-900">
                    {k === 'SEASON_PASS' ? 'Season pass' : k === 'PUNCH_CARD' ? 'Punch card' : 'Member rate'}
                  </span>
                  <span className="block text-xs text-slate-600">{KIND_HELP[k]}</span>
                </label>
              </div>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor={`${uid}-price`} className="block text-sm font-medium text-slate-700">
            Price to buy (USD)
          </label>
          <input
            id={`${uid}-price`}
            name="priceDollars"
            type="number"
            min="0"
            step="0.01"
            required
            defaultValue={(values.priceCents / 100).toFixed(2)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600"
          />
          <p className="mt-1 text-xs text-slate-600">Enter 0 for a membership you only ever comp.</p>
        </div>

        <div>
          <label htmlFor={`${uid}-discount-type`} className="block text-sm font-medium text-slate-700">
            Member discount is
          </label>
          <select
            id={`${uid}-discount-type`}
            name="discountType"
            value={discountType}
            onChange={(e) => setDiscountType(e.target.value as 'PERCENT' | 'FLAT')}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600"
          >
            <option value="PERCENT">A percentage off</option>
            <option value="FLAT">A dollar amount off</option>
          </select>
        </div>

        <div>
          <label htmlFor={`${uid}-discount`} className="block text-sm font-medium text-slate-700">
            {discountType === 'PERCENT' ? 'Percent off each booking' : 'Dollars off each booking'}
          </label>
          <input
            id={`${uid}-discount`}
            name="discountValue"
            type="number"
            min="0"
            max={discountType === 'PERCENT' ? 100 : undefined}
            step={discountType === 'PERCENT' ? 1 : 0.01}
            required
            defaultValue={discountDefault}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600"
          />
        </div>

        <div>
          <label htmlFor={`${uid}-duration`} className="block text-sm font-medium text-slate-700">
            Valid for (days)
          </label>
          <input
            id={`${uid}-duration`}
            name="durationDays"
            type="number"
            min="1"
            step="1"
            defaultValue={values.durationDays ?? ''}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600"
          />
          <p className="mt-1 text-xs text-slate-600">Leave blank for no expiry.</p>
        </div>

        {/*
          Only a punch card has uses. Rendering the field conditionally (rather than
          disabling it) keeps it out of the tab order and out of the accessibility
          tree entirely, so nobody tabs into a control that does nothing.
        */}
        {kind === 'PUNCH_CARD' ? (
          <div>
            <label htmlFor={`${uid}-uses`} className="block text-sm font-medium text-slate-700">
              Number of launches
            </label>
            <input
              id={`${uid}-uses`}
              name="totalUses"
              type="number"
              min="1"
              step="1"
              required
              defaultValue={values.totalUses ?? 10}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600"
            />
            <p className="mt-1 text-xs text-slate-600">One is spent per seat booked.</p>
          </div>
        ) : null}

        <div className="flex items-center gap-2 sm:col-span-2">
          <input
            id={`${uid}-active`}
            name="isActive"
            type="checkbox"
            defaultChecked={values.isActive}
            className="h-4 w-4 rounded border-slate-400 text-sky-700 focus:ring-2 focus:ring-sky-600"
          />
          <label htmlFor={`${uid}-active`} className="text-sm text-slate-700">
            For sale on the customer site
          </label>
        </div>
      </div>

      {isEdit ? (
        <p className="mt-4 rounded-md bg-slate-50 p-3 text-xs text-slate-700">
          Changing the discount changes what current members pay from their next booking
          onward. Uses and expiry are fixed when a membership is issued, so existing
          holders keep the terms they bought.
        </p>
      ) : null}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 disabled:opacity-70"
        >
          {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Create membership'}
        </button>
      </div>

      {/*
        aria-live so the outcome reaches a screen reader without moving focus; the
        error also carries role="alert" because a failed save is the one case worth
        interrupting for.
      */}
      <div aria-live="polite" className="mt-3 min-h-[1.25rem]">
        {result?.ok ? (
          <p className="text-sm text-emerald-800">{result.message ?? 'Saved.'}</p>
        ) : null}
        {result && !result.ok ? (
          <p role="alert" className="text-sm text-red-700">
            {result.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
