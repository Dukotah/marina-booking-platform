'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { createClientAction, type PlatformResult } from '../actions';

const FIELD =
  'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none';
const LABEL = 'block text-xs font-medium uppercase tracking-wide text-slate-400';

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
    >
      {pending ? 'Creating…' : 'Create client'}
    </button>
  );
}

function Err({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-xs text-rose-400">{msg}</p>;
}

export function NewClientForm() {
  const [state, action] = useFormState<PlatformResult | null, FormData>(createClientAction, null);
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const slugEdited = useRef(false);

  useEffect(() => {
    if (state?.ok) router.push('/platform');
  }, [state, router]);

  const e = state?.errors ?? {};

  return (
    <form action={action} className="space-y-6">
      {state?.message && (
        <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {state.message}
        </p>
      )}

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-sm font-semibold text-slate-200">Business</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="name">Business name</label>
            <input
              id="name"
              name="name"
              className={FIELD}
              placeholder="Russian River Kayak Co."
              onChange={(ev) => {
                if (!slugEdited.current) setSlug(slugify(ev.target.value));
              }}
              required
            />
            <Err msg={e.name} />
          </div>
          <div>
            <label className={LABEL} htmlFor="slug">Slug (subdomain)</label>
            <input
              id="slug"
              name="slug"
              className={FIELD}
              placeholder="russian-river-kayak"
              value={slug}
              onChange={(ev) => {
                slugEdited.current = true;
                setSlug(ev.target.value);
              }}
              required
            />
            <Err msg={e.slug} />
          </div>
          <div>
            <label className={LABEL} htmlFor="brandColor">Brand color</label>
            <input id="brandColor" name="brandColor" type="color" defaultValue="#0ea5e9" className="mt-1 h-9 w-16 rounded border border-slate-700 bg-slate-900" />
            <Err msg={e.brandColor} />
          </div>
          <div>
            <label className={LABEL} htmlFor="plan">Plan</label>
            <select id="plan" name="plan" className={FIELD} defaultValue="trial">
              <option value="trial">Trial</option>
              <option value="standard">Standard</option>
              <option value="pro">Pro</option>
            </select>
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-sm font-semibold text-slate-200">Owner login</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="ownerName">Owner name</label>
            <input id="ownerName" name="ownerName" className={FIELD} placeholder="Sam Rivera" required />
            <Err msg={e.ownerName} />
          </div>
          <div>
            <label className={LABEL} htmlFor="ownerEmail">Owner email</label>
            <input id="ownerEmail" name="ownerEmail" type="email" className={FIELD} placeholder="sam@rrkayak.com" required />
            <Err msg={e.ownerEmail} />
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-sm font-semibold text-slate-200">Location &amp; fees (optional)</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="city">City</label>
            <input id="city" name="city" className={FIELD} placeholder="Guerneville" />
          </div>
          <div>
            <label className={LABEL} htmlFor="state">State</label>
            <input id="state" name="state" className={FIELD} placeholder="CA" />
          </div>
          <div>
            <label className={LABEL} htmlFor="timezone">Timezone</label>
            <input id="timezone" name="timezone" className={FIELD} defaultValue="America/Los_Angeles" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL} htmlFor="salesTaxPercent">Sales tax %</label>
              <input id="salesTaxPercent" name="salesTaxPercent" type="number" step="0.01" className={FIELD} placeholder="8.5" />
            </div>
            <div>
              <label className={LABEL} htmlFor="processingFeePercent">Processing %</label>
              <input id="processingFeePercent" name="processingFeePercent" type="number" step="0.01" className={FIELD} placeholder="3.5" />
            </div>
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
          Cancel
        </button>
      </div>
    </form>
  );
}
