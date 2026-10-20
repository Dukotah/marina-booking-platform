'use client';

import { useState, useTransition } from 'react';
import { Plus, Pencil, Check, X, Trash2, Eye, EyeOff } from 'lucide-react';
import { Button, Input, Badge } from '../ui';
import { formatUSD } from '../../lib/format';
import {
  createMerchandiseItem,
  updateMerchandiseItem,
  toggleMerchandiseItem,
  deleteMerchandiseItem,
} from '../../app/catalog/merchandise/actions';

/** Common marina register categories, offered as suggestions (free text still allowed). */
const CATEGORY_SUGGESTIONS = [
  'Fuel',
  'Tubes & Towables',
  'Apparel',
  'Snacks',
  'Drinks',
  'Safety',
  'Accessories',
  'Bait & Tackle',
  'Other',
];

export interface MerchItem {
  id: string;
  name: string;
  category: string;
  variant: string | null;
  priceCents: number | null;
  costCents: number;
  onHandQty: number | null;
  reorderAlertQty: number | null;
  isActive: boolean;
}

/**
 * Merchandise catalog manager. The point is SPEED to add: the top row is a
 * single-line quick-add (name + category + price, Enter to save) so stocking
 * "fuel, tubes, koozies" is three keystrokes each, not a form per item. Everything
 * below is an inline-editable table. The register (POS) reads the same items.
 */
export function MerchandiseManager({ items }: { items: MerchItem[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  function runAdd(formData: FormData, reset: () => void) {
    setError(null);
    startTransition(async () => {
      const r = await createMerchandiseItem(formData);
      if (!r.ok) setError(r.error ?? 'Could not add item.');
      else reset();
    });
  }

  const lowStock = (i: MerchItem) =>
    i.onHandQty !== null && i.reorderAlertQty !== null && i.onHandQty <= i.reorderAlertQty;

  return (
    <div className="space-y-6">
      {/* Quick-add bar */}
      <form
        id="merch-quick-add"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-4 shadow-sm"
        action={(fd) => runAdd(fd, () => {
          const el = document.getElementById('merch-quick-add') as HTMLFormElement | null;
          el?.reset();
          el?.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
        })}
      >
        <div className="grow">
          <label htmlFor="qa-name" className="mb-1 block text-xs font-medium text-ink-muted">
            Item
          </label>
          <Input id="qa-name" name="name" placeholder="e.g. Fuel — 5 gal, Towable tube, Koozie" required className="w-full" />
        </div>
        <div>
          <label htmlFor="qa-cat" className="mb-1 block text-xs font-medium text-ink-muted">
            Category
          </label>
          <Input
            id="qa-cat"
            name="category"
            list="merch-categories"
            placeholder="Fuel"
            defaultValue="Other"
            className="w-40"
          />
          <datalist id="merch-categories">
            {CATEGORY_SUGGESTIONS.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div>
          <label htmlFor="qa-price" className="mb-1 block text-xs font-medium text-ink-muted">
            Price $
          </label>
          <Input id="qa-price" name="priceDollars" type="number" min="0" step="0.01" placeholder="0.00" className="w-28" />
        </div>
        <div>
          <label htmlFor="qa-qty" className="mb-1 block text-xs font-medium text-ink-muted">
            On hand
          </label>
          <Input id="qa-qty" name="onHandQty" type="number" min="0" step="1" placeholder="—" className="w-24" />
        </div>
        <Button type="submit" disabled={pending}>
          <Plus className="mr-1 h-4 w-4" aria-hidden />
          {pending ? 'Adding…' : 'Add item'}
        </Button>
        {error ? (
          <p role="alert" className="w-full text-sm text-rose-700">
            {error}
          </p>
        ) : null}
      </form>

      {/* Catalog table */}
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-surface-muted text-left text-xs uppercase tracking-wide text-ink-muted">
            <tr>
              <th className="px-4 py-2.5">Item</th>
              <th className="px-4 py-2.5">Category</th>
              <th className="px-4 py-2.5 text-right">Price</th>
              <th className="px-4 py-2.5 text-right">On hand</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-muted">
                  No merchandise yet. Add your first item above.
                </td>
              </tr>
            ) : (
              items.map((item) =>
                editingId === item.id ? (
                  <MerchEditRow
                    key={item.id}
                    item={item}
                    onCancel={() => setEditingId(null)}
                    onSaved={() => setEditingId(null)}
                  />
                ) : (
                  <tr key={item.id} className={item.isActive ? '' : 'opacity-55'}>
                    <td className="px-4 py-3 font-medium text-ink">
                      {item.name}
                      {item.variant ? <span className="text-ink-muted"> · {item.variant}</span> : null}
                    </td>
                    <td className="px-4 py-3 text-ink-body">{item.category}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {item.priceCents !== null ? formatUSD(item.priceCents) : <span className="text-ink-muted">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {item.onHandQty !== null ? (
                        <span className={lowStock(item) ? 'font-semibold text-amber-700' : ''}>
                          {item.onHandQty}
                          {lowStock(item) ? ' ⚠' : ''}
                        </span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={item.isActive ? 'success' : 'neutral'}>
                        {item.isActive ? 'On sale' : 'Hidden'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <IconBtn label="Edit" onClick={() => setEditingId(item.id)}>
                          <Pencil className="h-4 w-4" aria-hidden />
                        </IconBtn>
                        <IconBtn
                          label={item.isActive ? 'Hide from register' : 'Show at register'}
                          onClick={() =>
                            startTransition(() => toggleMerchandiseItem(item.id, !item.isActive).then(() => {}))
                          }
                        >
                          {item.isActive ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                        </IconBtn>
                        <IconBtn
                          label="Delete"
                          onClick={() => {
                            if (confirm(`Delete "${item.name}"?`))
                              startTransition(() => deleteMerchandiseItem(item.id).then((r) => setError(r.error ?? null)));
                          }}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </IconBtn>
                      </div>
                    </td>
                  </tr>
                ),
              )
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
    >
      {children}
    </button>
  );
}

function MerchEditRow({
  item,
  onCancel,
  onSaved,
}: {
  item: MerchItem;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formId = `merch-edit-${item.id}`;

  return (
    <tr className="bg-accent-tint/40">
      <td colSpan={6} className="px-4 py-3">
        <form
          id={formId}
          className="flex flex-wrap items-end gap-3"
          action={(fd) =>
            startTransition(async () => {
              const r = await updateMerchandiseItem(item.id, fd);
              if (!r.ok) setError(r.error ?? 'Could not save.');
              else onSaved();
            })
          }
        >
          <FieldMini label="Item" name="name" defaultValue={item.name} required className="w-48" />
          <FieldMini label="Category" name="category" defaultValue={item.category} list="merch-categories" className="w-36" />
          <FieldMini label="Variant" name="variant" defaultValue={item.variant ?? ''} className="w-28" />
          <FieldMini
            label="Price $"
            name="priceDollars"
            type="number"
            defaultValue={item.priceCents !== null ? (item.priceCents / 100).toFixed(2) : ''}
            className="w-24"
          />
          <FieldMini
            label="Cost $"
            name="costDollars"
            type="number"
            defaultValue={item.costCents ? (item.costCents / 100).toFixed(2) : ''}
            className="w-24"
          />
          <FieldMini
            label="On hand"
            name="onHandQty"
            type="number"
            defaultValue={item.onHandQty ?? ''}
            className="w-20"
          />
          <FieldMini
            label="Reorder at"
            name="reorderAlertQty"
            type="number"
            defaultValue={item.reorderAlertQty ?? ''}
            className="w-20"
          />
          <div className="flex gap-1">
            <Button type="submit" disabled={pending} size="sm">
              <Check className="mr-1 h-4 w-4" aria-hidden />
              Save
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              <X className="mr-1 h-4 w-4" aria-hidden />
              Cancel
            </Button>
          </div>
          {error ? (
            <p role="alert" className="w-full text-sm text-rose-700">
              {error}
            </p>
          ) : null}
        </form>
      </td>
    </tr>
  );
}

function FieldMini({
  label,
  className,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement> & { list?: string }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-ink-muted">{label}</label>
      <Input className={className} {...props} />
    </div>
  );
}
