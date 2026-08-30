'use client';

/**
 * Checkout add-ons — the operator's extras (life jackets, coolers, tubes, photo
 * packages, fuel) offered to a guest who has already decided to book.
 *
 * A controlled component: the parent owns the selection map so the live price
 * breakdown, the tip base and the submitted payload all read from one source of
 * truth. Nothing here talks to the API — the offers are loaded server-side on
 * the checkout page and the server re-prices every selection at booking time, so
 * a stale price or a stale stock count in this component can never become money.
 *
 * Two shapes of control, because there are two shapes of add-on:
 *
 *   - PER_GUEST  — one per person. A checkbox, because the quantity is not the
 *                  guest's to choose; it is the party size. Offering a stepper
 *                  would invite "2 life jackets for 5 people", which puts staff
 *                  a jacket short on the dock.
 *   - PER_BOOKING — a countable thing. A labelled number input plus large −/+
 *                  buttons: the buttons are the mobile target on a phone at the
 *                  ramp, the input is what a keyboard or screen-reader user
 *                  reaches for.
 *
 * Accessibility (held to e2e/specs/accessibility.spec.ts — zero serious/critical):
 *   - a <fieldset>/<legend> groups the whole set, and every control has a real
 *     <label> naming the add-on, so each one reads standalone out of context;
 *   - the −/+ buttons carry names that say what they do to WHICH add-on;
 *   - each control is described by its own price / stock note via
 *     aria-describedby, so the money is announced with the control;
 *   - every quantity change is announced through one polite live region, because
 *     pressing "+" otherwise changes a total silently;
 *   - selected state is carried by the control itself, never by colour alone,
 *     and the brand colour is used as a tint behind slate text — never white
 *     text on the brand, which is an operator-supplied colour we cannot vouch
 *     for the contrast of.
 */
import { useId, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { formatUSD } from '@marina/core';
import { cn } from '@marina/ui';

/** How an add-on's quantity is decided. Mirrors the API's `basis`. */
export type AddOnBasis = 'PER_GUEST' | 'PER_BOOKING';

/**
 * One add-on as offered by `GET /api/addons?activityId=&guests=`. Money is
 * integer cents; `maxSelectable` already accounts for stock and the operator's
 * per-booking cap.
 */
export interface CheckoutAddOn {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  basis: AddOnBasis;
  /** Units left, or null when the operator does not track stock. */
  remainingStock: number | null;
  /** Largest quantity this guest may take right now. 0 = sold out. */
  maxSelectable: number;
}

/** Chosen quantities, keyed by add-on id. Absent or 0 means "not selected". */
export type AddOnSelections = Record<string, number>;

interface AddOnsProps {
  addOns: CheckoutAddOn[];
  /** Party size — a per-guest add-on is priced and counted against it. */
  guestCount: number;
  selections: AddOnSelections;
  onChange: (selections: AddOnSelections) => void;
}

/**
 * The quantity an add-on resolves to for a given selection. Mirrors
 * `resolveQuantity` in the API's services/addons.ts — the server is still the
 * authority, this is only so the on-screen total matches what will be charged.
 */
export function resolvedQuantity(
  addOn: CheckoutAddOn,
  selected: number | undefined,
  guestCount: number,
): number {
  const requested = Math.max(0, Math.trunc(selected ?? 0));
  if (requested === 0 || addOn.maxSelectable === 0) return 0;
  return addOn.basis === 'PER_GUEST'
    ? Math.min(addOn.maxSelectable, Math.max(0, Math.trunc(guestCount)))
    : Math.min(requested, addOn.maxSelectable);
}

/**
 * The selected add-ons as pricing line items, to be appended to the seat line
 * before `calculatePricing` runs. Exported so the checkout's price breakdown and
 * tip base use the exact same numbers this component displays.
 */
export function selectedAddOnItems(
  addOns: readonly CheckoutAddOn[],
  selections: AddOnSelections,
  guestCount: number,
): Array<{ unitPriceCents: number; quantity: number }> {
  return addOns
    .map((a) => ({
      unitPriceCents: a.priceCents,
      quantity: resolvedQuantity(a, selections[a.id], guestCount),
    }))
    .filter((line) => line.quantity > 0);
}

/** The payload shape the booking request carries. Zero-quantity lines are dropped. */
export function selectedAddOnPayload(
  addOns: readonly CheckoutAddOn[],
  selections: AddOnSelections,
  guestCount: number,
): Array<{ addOnId: string; quantity: number }> {
  return addOns
    .map((a) => ({ addOnId: a.id, quantity: resolvedQuantity(a, selections[a.id], guestCount) }))
    .filter((line) => line.quantity > 0);
}

/** "$25.00 each" / "$12.00 per guest" — the price as the guest is charged it. */
function priceLabel(addOn: CheckoutAddOn): string {
  return addOn.basis === 'PER_GUEST'
    ? `${formatUSD(addOn.priceCents)} per guest`
    : `${formatUSD(addOn.priceCents)} each`;
}

/**
 * A short scarcity note, only when it is true and useful. Silent above five
 * remaining, because "only 40 left" is noise, and silent when stock is not
 * tracked at all.
 */
function stockNote(addOn: CheckoutAddOn): string | null {
  if (addOn.maxSelectable === 0) return 'Sold out';
  if (addOn.remainingStock === null || addOn.remainingStock > 5) return null;
  return addOn.remainingStock === 1 ? 'Only 1 left' : `Only ${addOn.remainingStock} left`;
}

export function AddOns({ addOns, guestCount, selections, onChange }: AddOnsProps) {
  const legendId = useId();
  // What the last interaction did, for the live region. Held as state (not
  // derived) so an unchanged selection does not re-announce on every render.
  const [announcement, setAnnouncement] = useState('');

  if (addOns.length === 0) return null;

  const set = (addOn: CheckoutAddOn, next: number) => {
    const quantity = Math.max(0, Math.min(next, addOn.maxSelectable));
    const resolved = resolvedQuantity(addOn, quantity, guestCount);
    onChange({ ...selections, [addOn.id]: quantity });
    setAnnouncement(
      resolved === 0
        ? `${addOn.name} removed.`
        : `${addOn.name}, ${resolved} × ${formatUSD(addOn.priceCents)}. ` +
          `${formatUSD(addOn.priceCents * resolved)} added.`,
    );
  };

  return (
    <fieldset className="min-w-0">
      <legend id={legendId} className="mb-1 text-sm font-medium text-slate-700">
        Add to your trip
      </legend>
      <p className="mb-3 text-xs text-slate-500">Optional. Added to the total below.</p>

      <ul className="space-y-2">
        {addOns.map((addOn) => (
          <li key={addOn.id}>
            <AddOnRow
              addOn={addOn}
              guestCount={guestCount}
              quantity={selections[addOn.id] ?? 0}
              onSet={(next) => set(addOn, next)}
            />
          </li>
        ))}
      </ul>

      {/*
        One polite live region for the whole set. Pressing "+" changes a price on
        the far side of the card; without this it changes silently.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </fieldset>
  );
}

function AddOnRow({
  addOn,
  guestCount,
  quantity,
  onSet,
}: {
  addOn: CheckoutAddOn;
  guestCount: number;
  quantity: number;
  onSet: (next: number) => void;
}) {
  const controlId = useId();
  const noteId = useId();

  const soldOut = addOn.maxSelectable === 0;
  const resolved = resolvedQuantity(addOn, quantity, guestCount);
  const selected = resolved > 0;
  const note = stockNote(addOn);

  // The per-guest quantity is the party size, so show what that costs rather
  // than the unit price alone — "$12 per guest" on a party of four is $48.
  const lineTotalCents = addOn.priceCents * resolved;

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3 transition-colors',
        soldOut
          ? 'border-slate-200 bg-slate-50'
          : selected
            ? 'border-[var(--brand-color)] bg-[var(--brand-color)]/10'
            : 'border-slate-300 bg-white',
      )}
    >
      <div className="min-w-0 flex-1">
        <label
          htmlFor={controlId}
          className={cn(
            'block text-sm font-medium',
            soldOut ? 'text-slate-500' : 'text-slate-900',
          )}
        >
          {addOn.name}
        </label>
        <p id={noteId} className="mt-0.5 text-xs text-slate-600">
          {priceLabel(addOn)}
          {addOn.description ? ` · ${addOn.description}` : ''}
          {note ? ` · ${note}` : ''}
          {selected && addOn.basis === 'PER_GUEST'
            ? ` · ${resolved} guest${resolved === 1 ? '' : 's'}, ${formatUSD(lineTotalCents)}`
            : ''}
        </p>
      </div>

      <div className="shrink-0">
        {addOn.basis === 'PER_GUEST' ? (
          <input
            id={controlId}
            type="checkbox"
            checked={selected}
            disabled={soldOut}
            aria-describedby={noteId}
            onChange={(e) => onSet(e.target.checked ? guestCount : 0)}
            className={cn(
              'mt-0.5 h-5 w-5 rounded border-slate-400 text-slate-900',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-color,#0f766e)] focus-visible:ring-offset-2',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
          />
        ) : (
          <div className="flex items-center gap-1.5">
            <StepButton
              label={`Remove one ${addOn.name}`}
              icon="minus"
              disabled={soldOut || resolved <= 0}
              onClick={() => onSet(resolved - 1)}
            />
            <input
              id={controlId}
              type="number"
              inputMode="numeric"
              min={0}
              max={addOn.maxSelectable}
              step={1}
              value={resolved}
              disabled={soldOut}
              aria-describedby={noteId}
              onChange={(e) => {
                const next = Number.parseInt(e.target.value, 10);
                onSet(Number.isFinite(next) ? next : 0);
              }}
              className={cn(
                'h-10 w-14 rounded-md border border-slate-300 bg-white text-center text-sm',
                'tabular-nums text-slate-900',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-color,#0f766e)] focus-visible:ring-offset-2',
                'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400',
              )}
            />
            <StepButton
              label={`Add one ${addOn.name}`}
              icon="plus"
              disabled={soldOut || resolved >= addOn.maxSelectable}
              onClick={() => onSet(resolved + 1)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A quantity step button. `type="button"` matters: this renders inside the
 * checkout <form>, and a default-type button would submit the booking.
 */
function StepButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: 'minus' | 'plus';
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = icon === 'minus' ? Minus : Plus;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'flex h-10 w-10 items-center justify-center rounded-md border border-slate-300 bg-white',
        'text-slate-700 transition-colors hover:bg-slate-50',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-color,#0f766e)] focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-40',
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  );
}
