'use client';

import { useEffect } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { updateClientAction, type PlatformResult } from '../actions';

const FIELD =
  'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none';
const LABEL = 'block text-xs font-medium uppercase tracking-wide text-slate-400';

export interface EditClientValues {
  id: string;
  slug: string;
  name_external: string;
  name_internal: string;
  brand_color: string;
  website: string;
  phone: string;
  timezone: string;
  legal_adult_age: number;
  plan: string;
  is_active: boolean;
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
    >
      {pending ? 'Saving…' : 'Save changes'}
    </button>
  );
}

function Err({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-xs text-rose-400">{msg}</p>;
}

export function EditClientForm({ values }: { values: EditClientValues }) {
  const action = updateClientAction.bind(null, values.id);
  const [state, formAction] = useFormState<PlatformResult | null, FormData>(action, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  const e = state?.errors ?? {};

  return (
    <form action={formAction} className="space-y-6">
      {state?.ok && (
        <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          Saved.
        </p>
      )}

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-sm font-semibold text-slate-200">Branding</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="name_external">Public name</label>
            <input id="name_external" name="name_external" className={FIELD} defaultValue={values.name_external} required />
            <Err msg={e.name_external} />
          </div>
          <div>
            <label className={LABEL} htmlFor="name_internal">Internal/legal name</label>
            <input id="name_internal" name="name_internal" className={FIELD} defaultValue={values.name_internal} />
          </div>
          <div>
            <label className={LABEL} htmlFor="brand_color">Brand color</label>
            <input id="brand_color" name="brand_color" type="color" defaultValue={values.brand_color} className="mt-1 h-9 w-16 rounded border border-slate-700 bg-slate-900" />
            <Err msg={e.brand_color} />
          </div>
          <div>
            <label className={LABEL} htmlFor="website">Website</label>
            <input id="website" name="website" className={FIELD} defaultValue={values.website} placeholder="https://…" />
          </div>
          <div>
            <label className={LABEL} htmlFor="phone">Phone</label>
            <input id="phone" name="phone" className={FIELD} defaultValue={values.phone} />
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-sm font-semibold text-slate-200">Account</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="plan">Plan</label>
            <select id="plan" name="plan" className={FIELD} defaultValue={values.plan}>
              <option value="trial">Trial</option>
              <option value="standard">Standard</option>
              <option value="pro">Pro</option>
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="timezone">Timezone</label>
            <input id="timezone" name="timezone" className={FIELD} defaultValue={values.timezone} required />
          </div>
          <div>
            <label className={LABEL} htmlFor="legal_adult_age">Legal adult age</label>
            <input id="legal_adult_age" name="legal_adult_age" type="number" className={FIELD} defaultValue={values.legal_adult_age} required />
            <Err msg={e.legal_adult_age} />
          </div>
          <div className="flex items-center gap-2 pt-6">
            <input id="is_active" name="is_active" type="checkbox" defaultChecked={values.is_active} className="h-4 w-4 rounded border-slate-600 bg-slate-900" />
            <label htmlFor="is_active" className="text-sm text-slate-300">Account active (uncheck to suspend)</label>
          </div>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Submit />
        <button
          type="button"
          onClick={() => router.push('/platform')}
          className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-300 transition hover:bg-slate-800"
        >
          Back
        </button>
      </div>
    </form>
  );
}
