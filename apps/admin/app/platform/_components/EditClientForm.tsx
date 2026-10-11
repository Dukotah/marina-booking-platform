'use client';

import { useEffect } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { updateClientAction, type PlatformResult } from '../actions';
import { Button, Input, Select, FieldLabel } from '../../../components/ui';

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
    <Button type="submit" variant="primary" size="md" disabled={pending}>
      {pending ? 'Saving…' : 'Save changes'}
    </Button>
  );
}

function Err({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-xs text-rose-700">{msg}</p>;
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
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Saved.
        </p>
      )}

      <section className="space-y-4 rounded-lg border border-line bg-surface p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-ink">Branding</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="name_external">Public name</FieldLabel>
            <Input id="name_external" name="name_external" defaultValue={values.name_external} required />
            <Err msg={e.name_external} />
          </div>
          <div>
            <FieldLabel htmlFor="name_internal">Internal/legal name</FieldLabel>
            <Input id="name_internal" name="name_internal" defaultValue={values.name_internal} />
          </div>
          <div>
            <FieldLabel htmlFor="brand_color">Brand color</FieldLabel>
            <input id="brand_color" name="brand_color" type="color" defaultValue={values.brand_color} className="h-11 w-16 rounded-lg border border-line bg-surface" />
            <Err msg={e.brand_color} />
          </div>
          <div>
            <FieldLabel htmlFor="website">Website</FieldLabel>
            <Input id="website" name="website" defaultValue={values.website} placeholder="https://…" />
          </div>
          <div>
            <FieldLabel htmlFor="phone">Phone</FieldLabel>
            <Input id="phone" name="phone" defaultValue={values.phone} />
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-line bg-surface p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-ink">Account</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="plan">Plan</FieldLabel>
            <Select id="plan" name="plan" defaultValue={values.plan}>
              <option value="trial">Trial</option>
              <option value="standard">Standard</option>
              <option value="pro">Pro</option>
            </Select>
          </div>
          <div>
            <FieldLabel htmlFor="timezone">Timezone</FieldLabel>
            <Input id="timezone" name="timezone" defaultValue={values.timezone} required />
          </div>
          <div>
            <FieldLabel htmlFor="legal_adult_age">Legal adult age</FieldLabel>
            <Input id="legal_adult_age" name="legal_adult_age" type="number" defaultValue={values.legal_adult_age} required />
            <Err msg={e.legal_adult_age} />
          </div>
          <div className="flex items-center gap-2 pt-6">
            <input id="is_active" name="is_active" type="checkbox" defaultChecked={values.is_active} className="h-4 w-4 rounded border-line-strong text-accent accent-accent focus:ring-focus" />
            <label htmlFor="is_active" className="text-sm text-ink-body">Account active (uncheck to suspend)</label>
          </div>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Submit />
        <Button type="button" variant="secondary" size="md" onClick={() => router.push('/platform')}>
          Back
        </Button>
      </div>
    </form>
  );
}
