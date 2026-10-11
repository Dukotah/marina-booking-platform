'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { createClientAction, type PlatformResult } from '../actions';
import { Button, Input, Select, FieldLabel } from '../../../components/ui';

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
    <Button type="submit" variant="primary" size="md" disabled={pending}>
      {pending ? 'Creating…' : 'Create client'}
    </Button>
  );
}

function Err({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-xs text-rose-700">{msg}</p>;
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
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {state.message}
        </p>
      )}

      <section className="space-y-4 rounded-lg border border-line bg-surface p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-ink">Business</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="name">Business name</FieldLabel>
            <Input
              id="name"
              name="name"
              placeholder="Russian River Kayak Co."
              onChange={(ev) => {
                if (!slugEdited.current) setSlug(slugify(ev.target.value));
              }}
              required
            />
            <Err msg={e.name} />
          </div>
          <div>
            <FieldLabel htmlFor="slug">Slug (subdomain)</FieldLabel>
            <Input
              id="slug"
              name="slug"
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
            <FieldLabel htmlFor="brandColor">Brand color</FieldLabel>
            <input id="brandColor" name="brandColor" type="color" defaultValue="#0ea5e9" className="h-11 w-16 rounded-lg border border-line bg-surface" />
            <Err msg={e.brandColor} />
          </div>
          <div>
            <FieldLabel htmlFor="plan">Plan</FieldLabel>
            <Select id="plan" name="plan" defaultValue="trial">
              <option value="trial">Trial</option>
              <option value="standard">Standard</option>
              <option value="pro">Pro</option>
            </Select>
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-line bg-surface p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-ink">Owner login</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="ownerName">Owner name</FieldLabel>
            <Input id="ownerName" name="ownerName" placeholder="Sam Rivera" required />
            <Err msg={e.ownerName} />
          </div>
          <div>
            <FieldLabel htmlFor="ownerEmail">Owner email</FieldLabel>
            <Input id="ownerEmail" name="ownerEmail" type="email" placeholder="sam@rrkayak.com" required />
            <Err msg={e.ownerEmail} />
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-line bg-surface p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-ink">Location &amp; fees (optional)</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="city">City</FieldLabel>
            <Input id="city" name="city" placeholder="Guerneville" />
          </div>
          <div>
            <FieldLabel htmlFor="state">State</FieldLabel>
            <Input id="state" name="state" placeholder="CA" />
          </div>
          <div>
            <FieldLabel htmlFor="timezone">Timezone</FieldLabel>
            <Input id="timezone" name="timezone" defaultValue="America/Los_Angeles" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel htmlFor="salesTaxPercent">Sales tax %</FieldLabel>
              <Input id="salesTaxPercent" name="salesTaxPercent" type="number" step="0.01" placeholder="8.5" />
            </div>
            <div>
              <FieldLabel htmlFor="processingFeePercent">Processing %</FieldLabel>
              <Input id="processingFeePercent" name="processingFeePercent" type="number" step="0.01" placeholder="3.5" />
            </div>
          </div>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Submit />
        <Button type="button" variant="secondary" size="md" onClick={() => router.push('/platform')}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
