'use client';

/**
 * Add-ons manager — the operator's checkout extras (life jackets, coolers, tubes,
 * photo packages, fuel). Lists what is defined, and edits one inline.
 *
 * Three decisions this UI makes explicit, because they are the ones an operator
 * gets wrong:
 *
 *   1. **Per guest vs per booking.** "Life jacket, $12 per guest" charges the
 *      party size and the guest only opts in; "Cooler, $25 each" lets them pick
 *      a number. The form says which one it is in plain words, and previews the
 *      charge for a party of four so the choice is not abstract.
 *   2. **Stock is a real limit, not a hint.** Setting it means the last one
 *      cannot be sold twice. The row shows sold/total, and the limit cannot be
 *      lowered below what is already on orders — the server refuses that and the
 *      message says why.
 *   3. **Price is entered in dollars and stored in integer cents**, parsed with
 *      `centsFromDecimal` (exact decimal-text parsing) rather than
 *      `dollars * 100`, which loses a cent on values like 1.005.
 *
 * Accessibility: every control has an explicit id + label association, the basis
 * choice is a radio group inside a fieldset (it is a choice between two, not a
 * dropdown of settings), save/delete failures are announced through a live
 * region, and no text is rendered white-on-brand.
 */
import { useId, useMemo, useState, useTransition } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { centsFromDecimal } from '@marina/core';
import { formatUSD } from '../../lib/format';
import {
  Field,
  PrimaryButton,
  SecondaryButton,
  Select,
  SettingsCard,
  TextInput,
} from './fields';

/** How an add-on's quantity is decided. Mirrors the API's `basis`. */
export type AddOnBasis = 'PER_GUEST' | 'PER_BOOKING';

/** One add-on row as loaded by the settings page. Money is integer cents. */
export interface AddOnRow {
  id: string;
  /** Null = offered on every activity. */
  activityId: string | null;
  name: string;
  description: string | null;
  priceCents: number;
  basis: AddOnBasis;
  maxPerBooking: number | null;
  stockTotal: number | null;
  stockSold: number;
  isActive: boolean;
  sortIndex: number;
}

export interface ActivityOption {
  id: string;
  name: string;
}

/** What a save sends. Price arrives as the dollar TEXT the operator typed. */
export interface AddOnFormInput {
  activityId: string | null;
  name: string;
  description: string | null;
  priceCents: number;
  basis: AddOnBasis;
  maxPerBooking: number | null;
  stockTotal: number | null;
  isActive: boolean;
  sortIndex: number;
}

/** Uniform result from the settings server actions. */
export interface AddOnActionResult {
  ok: boolean;
  message?: string;
}

interface AddOnEditorProps {
  addOns: AddOnRow[];
  activities: ActivityOption[];
  onSave: (id: string | null, input: AddOnFormInput) => Promise<AddOnActionResult>;
  onDelete: (id: string) => Promise<AddOnActionResult>;
}

/** The in-progress form state. Numbers stay as text so a half-typed value is not
 *  coerced to 0 under the operator's cursor. */
interface Draft {
  activityId: string;
  name: string;
  description: string;
  priceDollars: string;
  basis: AddOnBasis;
  maxPerBooking: string;
  stockTotal: string;
  isActive: boolean;
  sortIndex: string;
}

function emptyDraft(): Draft {
  return {
    activityId: '',
    name: '',
    description: '',
    priceDollars: '',
    basis: 'PER_BOOKING',
    maxPerBooking: '',
    stockTotal: '',
    isActive: true,
    sortIndex: '0',
  };
}

function rowToDraft(row: AddOnRow): Draft {
  return {
    activityId: row.activityId ?? '',
    name: row.name,
    description: row.description ?? '',
    priceDollars: (row.priceCents / 100).toFixed(2),
    basis: row.basis,
    maxPerBooking: row.maxPerBooking === null ? '' : String(row.maxPerBooking),
    stockTotal: row.stockTotal === null ? '' : String(row.stockTotal),
    isActive: row.isActive,
    sortIndex: String(row.sortIndex),
  };
}

/** Parse an optional whole-number field: blank means "no limit", not zero. */
function optionalInt(text: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

/** Turn a draft into the action payload, or into the first thing wrong with it. */
function draftToInput(draft: Draft): { ok: true; input: AddOnFormInput } | { ok: false; error: string } {
  const name = draft.name.trim();
  if (name === '') return { ok: false, error: 'Give the add-on a name.' };

  let priceCents: number;
  try {
    priceCents = centsFromDecimal(draft.priceDollars);
  } catch {
    return { ok: false, error: 'Enter the price as a dollar amount, e.g. 25.00.' };
  }
  if (priceCents < 0) return { ok: false, error: 'The price cannot be negative.' };

  const maxPerBooking = optionalInt(draft.maxPerBooking);
  if (!maxPerBooking.ok) return { ok: false, error: 'Max per booking must be a whole number, or blank for no limit.' };
  if (maxPerBooking.value === 0) return { ok: false, error: 'Max per booking must be at least 1, or blank for no limit.' };

  const stockTotal = optionalInt(draft.stockTotal);
  if (!stockTotal.ok) return { ok: false, error: 'Stock must be a whole number, or blank for unlimited.' };

  const sortIndex = optionalInt(draft.sortIndex);
  if (!sortIndex.ok) return { ok: false, error: 'Sort order must be a whole number.' };

  return {
    ok: true,
    input: {
      activityId: draft.activityId === '' ? null : draft.activityId,
      name,
      description: draft.description.trim() === '' ? null : draft.description.trim(),
      priceCents,
      basis: draft.basis,
      // A per-guest add-on's quantity IS the party size, so a per-booking cap is
      // meaningless on it — drop it rather than storing a value nothing reads.
      maxPerBooking: draft.basis === 'PER_GUEST' ? null : maxPerBooking.value,
      stockTotal: stockTotal.value,
      isActive: draft.isActive,
      sortIndex: sortIndex.value ?? 0,
    },
  };
}

export function AddOnEditor({ addOns, activities, onSave, onDelete }: AddOnEditorProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [status, setStatus] = useState<{ message: string; tone: 'error' | 'ok'; nonce: number } | null>(null);
  const [isPending, startTransition] = useTransition();

  const activityName = (id: string | null) =>
    id ? (activities.find((a) => a.id === id)?.name ?? 'Unknown activity') : 'All activities';

  const say = (message: string, tone: 'error' | 'ok') =>
    setStatus((prev) => ({ message, tone, nonce: (prev?.nonce ?? 0) + 1 }));

  function beginCreate() {
    setDraft(emptyDraft());
    setEditingId(null);
    setCreating(true);
    setStatus(null);
  }

  function beginEdit(row: AddOnRow) {
    setDraft(rowToDraft(row));
    setEditingId(row.id);
    setCreating(false);
    setStatus(null);
  }

  function cancel() {
    setCreating(false);
    setEditingId(null);
    setStatus(null);
  }

  function save() {
    const parsed = draftToInput(draft);
    if (!parsed.ok) {
      say(parsed.error, 'error');
      return;
    }
    startTransition(async () => {
      const result = await onSave(editingId, parsed.input);
      if (result.ok) {
        cancel();
        say(`Saved ${parsed.input.name}.`, 'ok');
        return;
      }
      say(result.message ?? 'Could not save the add-on.', 'error');
    });
  }

  function remove(row: AddOnRow) {
    startTransition(async () => {
      const result = await onDelete(row.id);
      say(result.message ?? (result.ok ? `Removed ${row.name}.` : 'Could not remove the add-on.'), result.ok ? 'ok' : 'error');
    });
  }

  const editorOpen = creating || editingId !== null;

  return (
    <SettingsCard
      title="Add-ons at checkout"
      description="Extras a guest can add while booking — life jackets, coolers, tubes, photo packages, fuel. They are taxed and processed exactly like the trip itself, and appear on the order, the manifest and the day's reports."
      footer={
        !editorOpen ? (
          <PrimaryButton type="button" onClick={beginCreate} disabled={isPending}>
            <Plus className="h-4 w-4" aria-hidden /> Add an add-on
          </PrimaryButton>
        ) : undefined
      }
    >
      {/*
        One live region for the whole card. A save that fails inside a transition
        changes nothing visible near the button the operator just pressed, so the
        outcome has to be announced rather than only rendered.
      */}
      <p
        role="status"
        aria-live="polite"
        className={
          status
            ? status.tone === 'error'
              ? 'mb-3 text-sm font-medium text-rose-700'
              : 'mb-3 text-sm font-medium text-emerald-700'
            : 'sr-only'
        }
      >
        {status?.message ?? ''}
      </p>

      {creating ? (
        <Editor draft={draft} setDraft={setDraft} activities={activities} onSave={save} onCancel={cancel} isPending={isPending} />
      ) : null}

      {addOns.length === 0 && !creating ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-600">
          No add-ons yet. These are the cheapest revenue you have — the guest is already at checkout.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {addOns.map((row) =>
            editingId === row.id ? (
              <li key={row.id} className="py-4">
                <Editor draft={draft} setDraft={setDraft} activities={activities} onSave={save} onCancel={cancel} isPending={isPending} />
              </li>
            ) : (
              <li key={row.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-900">{row.name}</span>
                    {!row.isActive ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                        Retired
                      </span>
                    ) : null}
                    {row.basis === 'PER_GUEST' ? (
                      <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800">
                        Per guest
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-600">
                    {formatUSD(row.priceCents)}
                    {row.basis === 'PER_GUEST' ? ' per guest' : ' each'} · {activityName(row.activityId)}
                    {row.maxPerBooking !== null ? ` · max ${row.maxPerBooking} per booking` : ''}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-600">
                    {row.stockTotal === null
                      ? 'Unlimited stock'
                      : `${row.stockSold} of ${row.stockTotal} sold · ${Math.max(0, row.stockTotal - row.stockSold)} left`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => beginEdit(row)}
                    disabled={isPending}
                    aria-label={`Edit ${row.name}`}
                    className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
                  >
                    <Pencil className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(row)}
                    disabled={isPending}
                    aria-label={
                      row.stockSold > 0 ? `Retire ${row.name}` : `Delete ${row.name}`
                    }
                    className="rounded-md p-1.5 text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </SettingsCard>
  );
}

function Editor({
  draft,
  setDraft,
  activities,
  onSave,
  onCancel,
  isPending,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  activities: ActivityOption[];
  onSave: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const ids = {
    name: useId(),
    price: useId(),
    activity: useId(),
    description: useId(),
    max: useId(),
    stock: useId(),
    sort: useId(),
    active: useId(),
    basis: useId(),
  };

  // A concrete preview beats an explanation: what a party of four is charged.
  const preview = useMemo(() => {
    let cents: number;
    try {
      cents = centsFromDecimal(draft.priceDollars);
    } catch {
      return null;
    }
    return draft.basis === 'PER_GUEST'
      ? `A party of 4 is charged ${formatUSD(cents * 4)} (4 × ${formatUSD(cents)}).`
      : `The guest picks a quantity; each one is ${formatUSD(cents)}.`;
  }, [draft.priceDollars, draft.basis]);

  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor={ids.name} required hint="What the guest sees at checkout.">
          <TextInput
            id={ids.name}
            value={draft.name}
            placeholder="e.g. Cooler with ice"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>

        <Field label="Price (USD)" htmlFor={ids.price} required hint="Stored to the cent.">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
              $
            </span>
            <TextInput
              id={ids.price}
              inputMode="decimal"
              className="pl-7"
              value={draft.priceDollars}
              placeholder="25.00"
              onChange={(e) => setDraft({ ...draft, priceDollars: e.target.value })}
            />
          </div>
        </Field>

        <Field
          label="Offered on"
          htmlFor={ids.activity}
          hint="One activity, or every activity you sell."
        >
          <Select
            id={ids.activity}
            value={draft.activityId}
            onChange={(e) => setDraft({ ...draft, activityId: e.target.value })}
          >
            <option value="">All activities</option>
            {activities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Description" htmlFor={ids.description} hint="Optional, one line.">
          <TextInput
            id={ids.description}
            value={draft.description}
            placeholder="Filled with ice, returned at the dock"
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </Field>
      </div>

      {/* A choice between two, so a radio group — not a select the operator has
          to open to discover the second option. */}
      <fieldset className="mt-4">
        <legend id={ids.basis} className="text-sm font-medium text-slate-700">
          How is it charged?
        </legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <BasisChoice
            name={`${ids.basis}-choice`}
            value="PER_BOOKING"
            checked={draft.basis === 'PER_BOOKING'}
            title="Per booking"
            detail="The guest chooses how many. A cooler, a tube, a photo package."
            onSelect={() => setDraft({ ...draft, basis: 'PER_BOOKING' })}
          />
          <BasisChoice
            name={`${ids.basis}-choice`}
            value="PER_GUEST"
            checked={draft.basis === 'PER_GUEST'}
            title="Per guest"
            detail="One each. The guest opts in and the party size sets the quantity."
            onSelect={() => setDraft({ ...draft, basis: 'PER_GUEST' })}
          />
        </div>
        {preview ? <p className="mt-2 text-xs text-slate-600">{preview}</p> : null}
      </fieldset>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field
          label="Max per booking"
          htmlFor={ids.max}
          hint={draft.basis === 'PER_GUEST' ? 'Set by the party size.' : 'Blank for no limit.'}
        >
          <TextInput
            id={ids.max}
            inputMode="numeric"
            value={draft.basis === 'PER_GUEST' ? '' : draft.maxPerBooking}
            disabled={draft.basis === 'PER_GUEST'}
            placeholder="No limit"
            onChange={(e) => setDraft({ ...draft, maxPerBooking: e.target.value })}
          />
        </Field>

        <Field
          label="Stock"
          htmlFor={ids.stock}
          hint="How many you own. Blank for unlimited; the last one can never be sold twice."
        >
          <TextInput
            id={ids.stock}
            inputMode="numeric"
            value={draft.stockTotal}
            placeholder="Unlimited"
            onChange={(e) => setDraft({ ...draft, stockTotal: e.target.value })}
          />
        </Field>

        <Field label="Sort order" htmlFor={ids.sort} hint="Lower shows first.">
          <TextInput
            id={ids.sort}
            inputMode="numeric"
            value={draft.sortIndex}
            onChange={(e) => setDraft({ ...draft, sortIndex: e.target.value })}
          />
        </Field>
      </div>

      <label
        htmlFor={ids.active}
        className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 hover:bg-slate-50"
      >
        <input
          id={ids.active}
          type="checkbox"
          checked={draft.isActive}
          onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
          className="mt-0.5 h-4 w-4 rounded border-slate-400 text-slate-900 focus:ring-slate-500"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-slate-800">Offer at checkout</span>
          <span className="block text-xs text-slate-600">
            Turn this off to retire the add-on without touching orders that already have it.
          </span>
        </span>
      </label>

      <div className="mt-4 flex items-center justify-end gap-2">
        <SecondaryButton type="button" onClick={onCancel} disabled={isPending}>
          <X className="h-4 w-4" aria-hidden /> Cancel
        </SecondaryButton>
        <PrimaryButton type="button" onClick={onSave} disabled={isPending}>
          <Check className="h-4 w-4" aria-hidden /> {isPending ? 'Saving…' : 'Save add-on'}
        </PrimaryButton>
      </div>
    </div>
  );
}

/** One option in the "how is it charged?" radio group. */
function BasisChoice({
  name,
  value,
  checked,
  title,
  detail,
  onSelect,
}: {
  name: string;
  value: AddOnBasis;
  checked: boolean;
  title: string;
  detail: string;
  onSelect: () => void;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={
        'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ' +
        (checked ? 'border-slate-800 bg-white' : 'border-slate-200 bg-white hover:bg-slate-100')
      }
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 h-4 w-4 border-slate-400 text-slate-900 focus:ring-slate-500"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-800">{title}</span>
        <span className="block text-xs text-slate-600">{detail}</span>
      </span>
    </label>
  );
}
