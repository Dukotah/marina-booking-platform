'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, Plus } from 'lucide-react';
import { Button, Input, Select, FieldLabel } from '../ui';
import { formatUSD, toCents } from '../../lib/format';
import {
  createPackage,
  updatePackage,
  type PackageInput,
} from '../../app/catalog/packages/actions';
import {
  emptyPackageForm,
  type ActivityOption,
  type PackageFormValues,
  type PackageItemInput,
} from '../../app/catalog/packages/types';

interface PackageFormProps {
  mode: 'create' | 'edit';
  packageId?: string;
  activities: ActivityOption[];
  defaultValues?: PackageFormValues;
}

/**
 * The package builder. One client form for both create and edit: set the
 * customer-facing name/description/price + status/visibility, then attach one or
 * more component lines (activity + rate + quantity). Shows live à-la-carte total
 * and the implied savings so the operator can see the discount they're offering.
 */
export function PackageForm({ mode, packageId, activities, defaultValues }: PackageFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<PackageFormValues>(
    defaultValues ?? emptyPackageForm(),
  );

  const activityById = useMemo(
    () => new Map(activities.map((a) => [a.id, a])),
    [activities],
  );

  function set<K extends keyof PackageFormValues>(key: K, v: PackageFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  function setItem(index: number, patch: Partial<PackageItemInput>) {
    setValues((prev) => {
      const items = prev.items.map((it, i) => (i === index ? { ...it, ...patch } : it));
      return { ...prev, items };
    });
  }

  function addItem() {
    setValues((prev) => ({
      ...prev,
      items: [...prev.items, { activityId: '', rateId: '', quantity: 1 }],
    }));
  }

  function removeItem(index: number) {
    setValues((prev) => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index),
    }));
  }

  // Live à-la-carte total from the picked rates.
  const aLaCarteCents = values.items.reduce((sum, it) => {
    const rate = activityById.get(it.activityId)?.rates.find((r) => r.id === it.rateId);
    return sum + (rate ? rate.priceCents * Math.max(1, it.quantity) : 0);
  }, 0);
  const priceCents = Number.isFinite(Number(values.priceDollars))
    ? toCents(Number(values.priceDollars))
    : 0;
  const savingsCents = Math.max(0, aLaCarteCents - priceCents);

  function submit() {
    setError(null);
    const payload: PackageInput = {
      nameInternal: values.nameInternal,
      nameExternal: values.nameExternal,
      descriptionHtml: values.descriptionHtml,
      priceDollars: values.priceDollars,
      status: values.status,
      visibleOnline: values.visibleOnline,
      sortIndex: values.sortIndex,
      items: values.items.map((it) => ({
        activityId: it.activityId,
        rateId: it.rateId,
        quantity: it.quantity,
      })),
    };
    startTransition(async () => {
      const result =
        mode === 'create'
          ? await createPackage(payload)
          : await updatePackage(packageId as string, payload);
      if (result.ok) {
        router.push('/catalog/packages');
        router.refresh();
      } else {
        setError(result.error ?? 'Something went wrong.');
      }
    });
  }

  return (
    <form
      className="max-w-3xl space-y-8"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <section className="space-y-4">
        <div>
          <FieldLabel htmlFor="nameExternal">Customer-facing name</FieldLabel>
          <Input
            id="nameExternal"
            value={values.nameExternal}
            onChange={(e) => set('nameExternal', e.target.value)}
            placeholder="Sunset Paddle + Photo Combo"
            required
          />
        </div>
        <div>
          <FieldLabel htmlFor="nameInternal">Internal name</FieldLabel>
          <Input
            id="nameInternal"
            value={values.nameInternal}
            onChange={(e) => set('nameInternal', e.target.value)}
            placeholder="sunset-combo"
            required
          />
        </div>
        <div>
          <FieldLabel htmlFor="descriptionHtml">Description</FieldLabel>
          <textarea
            id="descriptionHtml"
            value={values.descriptionHtml}
            onChange={(e) => set('descriptionHtml', e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink shadow-sm transition-colors placeholder:text-ink-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus"
            placeholder="What's included and why it's a great deal."
          />
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Included items</h2>
          <Button type="button" variant="secondary" size="sm" onClick={addItem}>
            <Plus className="h-4 w-4" aria-hidden /> Add item
          </Button>
        </div>

        <div className="space-y-3">
          {values.items.map((item, index) => {
            const activity = activityById.get(item.activityId);
            return (
              <div
                key={index}
                className="grid grid-cols-1 gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-[1fr_1fr_6rem_auto] sm:items-end"
              >
                <div>
                  <FieldLabel htmlFor={`activity-${index}`}>Activity</FieldLabel>
                  <Select
                    id={`activity-${index}`}
                    value={item.activityId}
                    onChange={(e) =>
                      setItem(index, { activityId: e.target.value, rateId: '' })
                    }
                    required
                  >
                    <option value="">Select…</option>
                    {activities.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <FieldLabel htmlFor={`rate-${index}`}>Rate</FieldLabel>
                  <Select
                    id={`rate-${index}`}
                    value={item.rateId}
                    onChange={(e) => setItem(index, { rateId: e.target.value })}
                    disabled={!activity}
                    required
                  >
                    <option value="">Select…</option>
                    {activity?.rates.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} — {formatUSD(r.priceCents)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <FieldLabel htmlFor={`qty-${index}`}>Qty</FieldLabel>
                  <Input
                    id={`qty-${index}`}
                    type="number"
                    min={1}
                    value={item.quantity}
                    onChange={(e) =>
                      setItem(index, { quantity: Math.max(1, Number(e.target.value) || 1) })
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeItem(index)}
                  disabled={values.items.length === 1}
                  aria-label="Remove item"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <FieldLabel htmlFor="priceDollars">Bundle price (USD)</FieldLabel>
          <Input
            id="priceDollars"
            type="number"
            step="0.01"
            min="0"
            value={values.priceDollars}
            onChange={(e) => set('priceDollars', e.target.value)}
            placeholder="99.00"
            required
          />
        </div>
        <div>
          <FieldLabel htmlFor="status">Status</FieldLabel>
          <Select
            id="status"
            value={values.status}
            onChange={(e) => set('status', e.target.value as PackageFormValues['status'])}
          >
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
        </div>
        <div>
          <FieldLabel htmlFor="sortIndex">Sort order</FieldLabel>
          <Input
            id="sortIndex"
            type="number"
            min={0}
            value={values.sortIndex}
            onChange={(e) => set('sortIndex', Math.max(0, Number(e.target.value) || 0))}
          />
        </div>
        <label className="flex items-center gap-2 self-end pb-2.5 text-sm text-ink">
          <input
            type="checkbox"
            checked={values.visibleOnline}
            onChange={(e) => set('visibleOnline', e.target.checked)}
            className="h-4 w-4 rounded border-line text-accent focus:ring-focus"
          />
          Show in online catalog
        </label>
      </section>

      <div className="rounded-lg border border-line bg-surface-muted p-4 text-sm">
        <div className="flex justify-between">
          <span className="text-ink-muted">À la carte total</span>
          <span className="tabular-nums text-ink">{formatUSD(aLaCarteCents)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-ink-muted">Bundle price</span>
          <span className="tabular-nums text-ink">{formatUSD(priceCents)}</span>
        </div>
        <div className="mt-1 flex justify-between border-t border-line pt-1 font-medium">
          <span className="text-ink">Customer saves</span>
          <span className="tabular-nums text-ink">{formatUSD(savingsCents)}</span>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      <div className="flex gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : mode === 'create' ? 'Create package' : 'Save changes'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.push('/catalog/packages')}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
