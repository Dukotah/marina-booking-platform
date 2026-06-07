'use client';

import { useState, useTransition } from 'react';
import { Plus, X } from 'lucide-react';
import { createPromo, type CreatePromoInput, type ActionResult } from '../../app/promos/actions';

const EMPTY: CreatePromoInput = {
  code: '',
  name: '',
  discount_type: 'PERCENT',
  discount_value: 0,
  valid_from: null,
  valid_until: null,
  max_redemptions: null,
};

/**
 * Dialog for creating a new promo code. Collects code, name, discount type/value,
 * optional date range, and optional redemption cap. Calls the createPromo server
 * action on submit. Closes and resets on success.
 */
export function CreatePromoDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CreatePromoInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function reset() {
    setForm(EMPTY);
    setError(null);
  }

  function close() {
    if (isPending) return;
    setOpen(false);
    reset();
  }

  function set<K extends keyof CreatePromoInput>(key: K, value: CreatePromoInput[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function submit() {
    if (isPending) return;
    setError(null);
    const payload: CreatePromoInput = {
      ...form,
      discount_value: Number(form.discount_value),
      max_redemptions: form.max_redemptions ? Number(form.max_redemptions) : null,
      valid_from: form.valid_from || null,
      valid_until: form.valid_until || null,
    };
    startTransition(async () => {
      const result: ActionResult = await createPromo(payload);
      if (result.ok) {
        close();
      } else {
        setError(result.error ?? 'Something went wrong.');
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800"
      >
        <Plus className="h-4 w-4" aria-hidden />
        New promo
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Create promo code"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => e.target === e.currentTarget && close()}
        >
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2 className="text-base font-semibold text-slate-900">New promo code</h2>
              <button
                type="button"
                onClick={close}
                disabled={isPending}
                className="rounded-lg p-1 text-slate-400 hover:text-slate-700 disabled:opacity-40"
              >
                <X className="h-5 w-5" aria-hidden />
                <span className="sr-only">Close</span>
              </button>
            </div>

            <div className="space-y-4 px-6 py-5">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="promo-code">
                  Code <span className="text-rose-500">*</span>
                </label>
                <input
                  id="promo-code"
                  type="text"
                  value={form.code}
                  onChange={(e) => set('code', e.target.value.toUpperCase())}
                  placeholder="SUMMER20"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm uppercase shadow-sm focus:border-slate-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="promo-name">
                  Name <span className="text-rose-500">*</span>
                </label>
                <input
                  id="promo-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="Summer 20% Off"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="promo-dtype">
                    Type
                  </label>
                  <select
                    id="promo-dtype"
                    value={form.discount_type}
                    onChange={(e) => set('discount_type', e.target.value as 'PERCENT' | 'FLAT')}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none"
                  >
                    <option value="PERCENT">Percent off</option>
                    <option value="FLAT">Fixed $ off</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="promo-dvalue">
                    {form.discount_type === 'PERCENT' ? '% off' : '$ off'}{' '}
                    <span className="text-rose-500">*</span>
                  </label>
                  <input
                    id="promo-dvalue"
                    type="number"
                    min={0}
                    max={form.discount_type === 'PERCENT' ? 100 : undefined}
                    step={form.discount_type === 'PERCENT' ? 1 : 0.01}
                    value={form.discount_value}
                    onChange={(e) => set('discount_value', Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="promo-from">
                    Valid from
                  </label>
                  <input
                    id="promo-from"
                    type="date"
                    value={form.valid_from ? form.valid_from.slice(0, 10) : ''}
                    onChange={(e) =>
                      set('valid_from', e.target.value ? `${e.target.value}T00:00:00.000Z` : null)
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="promo-until">
                    Expires
                  </label>
                  <input
                    id="promo-until"
                    type="date"
                    value={form.valid_until ? form.valid_until.slice(0, 10) : ''}
                    onChange={(e) =>
                      set('valid_until', e.target.value ? `${e.target.value}T23:59:59.000Z` : null)
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="promo-max">
                  Max redemptions
                </label>
                <input
                  id="promo-max"
                  type="number"
                  min={1}
                  step={1}
                  placeholder="Unlimited"
                  value={form.max_redemptions ?? ''}
                  onChange={(e) =>
                    set('max_redemptions', e.target.value ? Number(e.target.value) : null)
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none"
                />
              </div>

              {error ? <p className="text-sm font-medium text-rose-600">{error}</p> : null}
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4">
              <button
                type="button"
                onClick={close}
                disabled={isPending}
                className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={isPending}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-40"
              >
                {isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
