'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  CalendarClock,
  Check,
  Loader2,
  Pencil,
  Phone,
  Plus,
  RotateCcw,
  UserX,
  Users,
  X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { formatRelative, formatUSD } from '../../lib/format';
import { SignLinkActions } from '../waiver/SignLinkActions';
import {
  checkInOrderItem,
  undoCheckInOrderItem,
  markNoShowOrderItem,
  undoNoShowOrderItem,
} from '../../app/manifest/actions';
import {
  addOrderChargeAction,
  cancelOrderAction,
  collectBalanceAction,
} from '../../app/orders/actions';
import {
  addOrderNote,
  listRescheduleSlots,
  loadReservationCard,
  rescheduleReservation,
  updateGuestContact,
  type ReservationCardData,
  type RescheduleSlot,
} from '../../app/calendar/actions';

/**
 * The reservation card: click a booking anywhere on the calendar and run the whole
 * reservation from a slide-over — guest details, reschedule, party/charges, status
 * ops, money, waiver, notes — without leaving the calendar. Every mutation goes
 * through an EXISTING server action / service (see app/calendar/actions.ts header);
 * this component is orchestration + the dialog a11y contract.
 *
 * Dialog contract (same one the QR overlay and the order-page panels honour):
 * focus moves into the dialog on open, Tab cycles inside it, Escape closes, and
 * focus returns to the chip/name that opened it. (2.1.2, 2.4.3)
 */
export function ReservationCard({
  orderItemId,
  onClose,
}: {
  orderItemId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const titleId = useId();

  const [card, setCard] = useState<ReservationCardData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [pending, startTransition] = useTransition();

  const reload = useCallback(async () => {
    const res = await loadReservationCard(orderItemId);
    if (res.ok && res.card) {
      setCard(res.card);
      setLoadError(null);
    } else {
      setLoadError(res.error ?? 'Could not load the reservation.');
    }
  }, [orderItemId]);

  // Initial load.
  useEffect(() => {
    setCard(null);
    setLoadError(null);
    void reload();
  }, [reload]);

  // Focus in on open; hand it back to the opener on unmount. If the opener's DOM
  // node was replaced meanwhile (a reschedule moves the chip to another column and
  // router.refresh() remounts it), fall back to the trigger carrying the same
  // reservation id, so the keyboard still lands somewhere sensible.
  const openerItemIdRef = useRef(orderItemId);
  useEffect(() => {
    openerRef.current = document.activeElement;
    panelRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
        return;
      }
      document
        .querySelector<HTMLElement>(`[data-reservation-trigger="${openerItemIdRef.current}"]`)
        ?.focus();
    };
  }, []);

  // Escape closes; Tab is trapped inside the dialog.
  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !panelRef.current) return;
    const focusables = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /** Run a mutation: on success announce it, refresh the card AND the page behind. */
  function run(
    success: string,
    action: () => Promise<{ ok: boolean; error?: string; message?: string }>,
    after?: () => void,
  ) {
    setError(null);
    setAnnouncement('');
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setError(res.error ?? res.message ?? 'Could not update the reservation.');
        return;
      }
      setAnnouncement(res.message && res.message !== success ? `${success} ${res.message}` : success);
      after?.();
      await reload();
      router.refresh();
    });
  }

  const inactive =
    card !== null && (card.orderStatus === 'CANCELLED' || card.itemStatus === 'CANCELLED');
  const canWrite = Boolean(card?.canWrite) && !inactive;

  return (
    <div className="fixed inset-0 z-50" onKeyDown={onKeyDown}>
      {/* Backdrop — click closes, like the QR overlay. */}
      <div
        className="absolute inset-0 bg-slate-900/40"
        aria-hidden
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-xl focus:outline-none"
      >
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>

        {/* Header */}
        <div className="relative shrink-0 border-b border-slate-200 px-5 py-4">
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-1"
            style={{ backgroundColor: card?.activityColor ?? '#94a3b8' }}
          />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id={titleId} className="truncate text-base font-semibold text-slate-900">
                {card ? card.activityName : 'Reservation'}
              </h2>
              {card ? (
                <p className="mt-0.5 text-sm text-slate-600">
                  <span className="font-medium tabular-nums text-slate-800">
                    {card.dayLabel} · {card.timeLabel}
                  </span>
                  <span className="mx-1.5 text-slate-300">|</span>
                  <span className="font-mono text-xs">{card.orderNumber}</span>
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {card ? <StatusPill status={card.itemStatus} /> : null}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close reservation card"
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loadError ? (
            <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
              {loadError}
            </p>
          ) : !card ? (
            <p className="flex items-center gap-2 py-8 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading reservation…
            </p>
          ) : (
            <div className="space-y-6">
              {error ? (
                <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
                  {error}
                </p>
              ) : null}

              {inactive ? (
                <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  This reservation is cancelled. It can be reviewed but not changed here.
                </p>
              ) : null}

              {/* Status ops */}
              {canWrite ? (
                <StatusOps card={card} pending={pending} run={run} />
              ) : null}

              <GuestSection card={card} pending={pending} run={run} />

              <RescheduleSection card={card} pending={pending} canWrite={canWrite} run={run} />

              <PartySection card={card} pending={pending} canWrite={canWrite} run={run} />

              <MoneySection card={card} pending={pending} canWrite={canWrite} run={run} />

              <WaiverSection card={card} />

              <NotesSection card={card} pending={pending} canWrite={Boolean(card.canWrite)} run={run} />
            </div>
          )}
        </div>

        {/* Footer */}
        {card ? (
          <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-5 py-3">
            <Link
              href={`/orders/${card.orderId}`}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
            >
              Open full order <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type RunFn = (
  success: string,
  action: () => Promise<{ ok: boolean; error?: string; message?: string }>,
  after?: () => void,
) => void;

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</h3>
  );
}

function StatusPill({ status }: { status: ReservationCardData['itemStatus'] }) {
  const map: Record<string, { label: string; cls: string }> = {
    UPCOMING: { label: 'Upcoming', cls: 'bg-sky-50 text-sky-700' },
    CHECKED_IN: { label: 'Checked in', cls: 'bg-emerald-50 text-emerald-700' },
    NO_SHOW: { label: 'No-show', cls: 'bg-slate-100 text-slate-600' },
    CANCELLED: { label: 'Cancelled', cls: 'bg-rose-50 text-rose-700' },
    COMPLETED: { label: 'Completed', cls: 'bg-slate-100 text-slate-600' },
  };
  const s = map[status] ?? { label: status, cls: 'bg-slate-100 text-slate-600' };
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${s.cls}`}>{s.label}</span>;
}

/** One-tap check-in / no-show / undo — the same manifest actions, from the card. */
function StatusOps({
  card,
  pending,
  run,
}: {
  card: ReservationCardData;
  pending: boolean;
  run: RunFn;
}) {
  const name = `${card.customer.firstName} ${card.customer.lastName}`.trim();
  if (card.itemStatus === 'UPCOMING') {
    return (
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(`Checked in ${name}.`, () => checkInOrderItem(card.orderItemId))}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-md bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          <Check className="h-4 w-4" aria-hidden /> Check in
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            run(`Marked ${name} as a no-show.`, () => markNoShowOrderItem(card.orderItemId))
          }
          className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          <UserX className="h-4 w-4" aria-hidden /> No-show
        </button>
      </div>
    );
  }
  if (card.itemStatus === 'CHECKED_IN' || card.itemStatus === 'NO_SHOW') {
    const isCheckIn = card.itemStatus === 'CHECKED_IN';
    return (
      <div>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            run(
              isCheckIn ? `Check-in undone for ${name}.` : `No-show undone for ${name}.`,
              () =>
                isCheckIn
                  ? undoCheckInOrderItem(card.orderItemId)
                  : undoNoShowOrderItem(card.orderItemId),
            )
          }
          className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          <RotateCcw className="h-4 w-4" aria-hidden />
          {isCheckIn ? 'Undo check-in' : 'Undo no-show'}
        </button>
      </div>
    );
  }
  return null;
}

/** Guest name / email / phone, editable inline (customer:write). */
function GuestSection({
  card,
  pending,
  run,
}: {
  card: ReservationCardData;
  pending: boolean;
  run: RunFn;
}) {
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState(card.customer.firstName);
  const [last, setLast] = useState(card.customer.lastName);
  const [email, setEmail] = useState(card.customer.email);
  const [phone, setPhone] = useState(card.customer.phone ?? '');
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const editTriggerRef = useRef<HTMLButtonElement>(null);
  const ids = { first: useId(), last: useId(), email: useId(), phone: useId() };

  // Keep the draft in step with fresh server data while not editing.
  useEffect(() => {
    if (editing) return;
    setFirst(card.customer.firstName);
    setLast(card.customer.lastName);
    setEmail(card.customer.email);
    setPhone(card.customer.phone ?? '');
  }, [card, editing]);

  useEffect(() => {
    if (editing) firstFieldRef.current?.focus();
  }, [editing]);

  function save() {
    run(
      'Guest details saved.',
      () =>
        updateGuestContact({
          customerId: card.customer.id,
          orderId: card.orderId,
          firstName: first,
          lastName: last,
          email,
          phone,
        }),
      () => {
        setEditing(false);
        editTriggerRef.current?.focus();
      },
    );
  }

  const inputCls =
    'mt-0.5 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500';

  return (
    <section aria-label="Guest">
      <div className="flex items-center justify-between">
        <SectionHeading>Guest</SectionHeading>
        {card.canEditCustomer && !editing ? (
          <button
            type="button"
            ref={editTriggerRef}
            onClick={() => setEditing(true)}
            aria-label={`Edit contact details for ${card.customer.firstName} ${card.customer.lastName}`}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
          </button>
        ) : null}
      </div>

      {!editing ? (
        <div className="mt-1.5">
          <p className="text-base font-medium text-slate-900">
            {card.customer.firstName} {card.customer.lastName}
          </p>
          <p className="mt-0.5 text-sm text-slate-600">{card.customer.email}</p>
          {card.customer.phone ? (
            <a
              href={`tel:${card.customer.phone}`}
              className="mt-0.5 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-800"
            >
              <Phone className="h-3.5 w-3.5" aria-hidden /> {card.customer.phone}
            </a>
          ) : (
            <p className="mt-0.5 text-sm text-slate-500">No phone on file</p>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          <div className="grid grid-cols-2 gap-2">
            <label htmlFor={ids.first} className="text-xs font-medium text-slate-600">
              First name
              <input id={ids.first} ref={firstFieldRef} value={first} onChange={(e) => setFirst(e.target.value)} className={inputCls} />
            </label>
            <label htmlFor={ids.last} className="text-xs font-medium text-slate-600">
              Last name
              <input id={ids.last} value={last} onChange={(e) => setLast(e.target.value)} className={inputCls} />
            </label>
          </div>
          <label htmlFor={ids.email} className="block text-xs font-medium text-slate-600">
            Email
            <input id={ids.email} type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
          </label>
          <label htmlFor={ids.phone} className="block text-xs font-medium text-slate-600">
            Phone
            <input id={ids.phone} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(707) 555-0100" className={inputCls} />
          </label>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              disabled={pending || !first.trim() || !last.trim() || !email.trim()}
              onClick={save}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Save
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                editTriggerRef.current?.focus();
              }}
              className="inline-flex min-h-9 items-center rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Reschedule to another slot of the same activity (staff-side — no customer window). */
function RescheduleSection({
  card,
  pending,
  canWrite,
  run,
}: {
  card: ReservationCardData;
  pending: boolean;
  canWrite: boolean;
  run: RunFn;
}) {
  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState<RescheduleSlot[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RescheduleSlot | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Load candidates when the panel opens (and after a successful move re-open).
  useEffect(() => {
    if (!open) return;
    let live = true;
    setSlots(null);
    setSlotsError(null);
    setSelected(null);
    void listRescheduleSlots(card.orderItemId).then((res) => {
      if (!live) return;
      if (res.ok && res.slots) setSlots(res.slots);
      else setSlotsError(res.error ?? 'Could not load available times.');
    });
    return () => {
      live = false;
    };
  }, [open, card.orderItemId, card.timeslotId]);

  // Group by day for scannable rendering.
  const groups: { day: string; slots: RescheduleSlot[] }[] = [];
  if (slots) {
    for (const s of slots) {
      const g = groups[groups.length - 1];
      if (g && g.day === s.dayLabel) g.slots.push(s);
      else groups.push({ day: s.dayLabel, slots: [s] });
    }
  }

  return (
    <section aria-label="Date and time">
      <SectionHeading>When</SectionHeading>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-700">
          <span className="font-semibold tabular-nums text-slate-900">
            {card.dayLabel} · {card.timeLabel}
          </span>
        </p>
        {canWrite ? (
          <button
            type="button"
            ref={triggerRef}
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
          >
            <CalendarClock className="h-3.5 w-3.5" aria-hidden />
            {open ? 'Close' : 'Reschedule'}
          </button>
        ) : null}
      </div>

      {open ? (
        <div id={panelId} className="mt-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          {slotsError ? (
            <p role="alert" className="text-sm font-medium text-rose-700">
              {slotsError}
            </p>
          ) : slots === null ? (
            <p className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading available times…
            </p>
          ) : slots.length === 0 ? (
            <p className="text-sm text-slate-600">No upcoming timeslots for this activity.</p>
          ) : (
            <>
              <p className="text-xs text-slate-600">
                Pick a new time for this {card.quantity}-guest booking. Full slots are disabled.
              </p>
              <div className="mt-2 max-h-64 space-y-3 overflow-y-auto pr-1">
                {groups.map((g) => (
                  <div key={g.day}>
                    <p className="text-xs font-semibold text-slate-700">{g.day}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {g.slots.map((s) => {
                        const disabled = s.isCurrent || !s.hasRoom;
                        const isSelected = selected?.timeslotId === s.timeslotId;
                        return (
                          <button
                            key={s.timeslotId}
                            type="button"
                            disabled={disabled}
                            aria-pressed={isSelected}
                            title={
                              s.isCurrent
                                ? 'Current time'
                                : s.hasRoom
                                  ? `${s.remaining} of ${s.capacityTotal} open`
                                  : 'Not enough room'
                            }
                            onClick={() => setSelected(isSelected ? null : s)}
                            className={cn(
                              'rounded-md border px-2 py-1 text-xs font-medium tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500',
                              isSelected
                                ? 'border-slate-900 bg-slate-900 text-white'
                                : disabled
                                  ? 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400'
                                  : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50',
                            )}
                          >
                            {s.timeLabel}
                            {s.isCurrent ? ' (current)' : ''}
                            <span className="sr-only">
                              {s.dayLabel},{' '}
                              {s.isCurrent
                                ? 'the current time'
                                : s.hasRoom
                                  ? `${s.remaining} spots open`
                                  : 'full'}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={pending || !selected}
                  onClick={() =>
                    selected &&
                    run(
                      `Moved to ${selected.dayLabel} · ${selected.timeLabel}.`,
                      () =>
                        rescheduleReservation({
                          orderId: card.orderId,
                          orderItemId: card.orderItemId,
                          timeslotId: selected.timeslotId,
                        }),
                      () => {
                        setOpen(false);
                        triggerRef.current?.focus();
                      },
                    )
                  }
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  {selected ? `Move to ${selected.dayLabel} · ${selected.timeLabel}` : 'Pick a time'}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className="inline-flex min-h-9 items-center rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                  Keep current time
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

const CHARGE_CATEGORIES: { value: string; label: string }[] = [
  { value: 'FUEL', label: 'Fuel' },
  { value: 'CLEANING', label: 'Cleaning' },
  { value: 'DAMAGE', label: 'Damage' },
  { value: 'LATE', label: 'Late return' },
  { value: 'OTHER', label: 'Other' },
];

/** Party size + rate line, and the post-trip "add fuel / charge" flow. */
function PartySection({
  card,
  pending,
  canWrite,
  run,
}: {
  card: ReservationCardData;
  pending: boolean;
  canWrite: boolean;
  run: RunFn;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('FUEL');
  const [note, setNote] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const ids = { amount: useId(), category: useId(), note: useId() };

  const parsedCents = Math.round(parseFloat(amount.replace(/[^0-9.]/g, '') || '0') * 100);

  function submit() {
    if (parsedCents <= 0) return;
    run(
      `Added ${category.toLowerCase()} charge of ${formatUSD(parsedCents)}.`,
      () =>
        addOrderChargeAction({
          orderId: card.orderId,
          category,
          label: note.trim() || undefined,
          amountCents: parsedCents,
        }),
      () => {
        setOpen(false);
        setAmount('');
        setNote('');
        setCategory('FUEL');
        triggerRef.current?.focus();
      },
    );
  }

  return (
    <section aria-label="Party and charges">
      <SectionHeading>Party &amp; extras</SectionHeading>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-700">
        <span className="inline-flex items-center gap-1 font-medium text-slate-900">
          <Users className="h-4 w-4 text-slate-500" aria-hidden /> {card.quantity}{' '}
          {card.quantity === 1 ? 'guest' : 'guests'}
        </span>
        <span>
          {card.rateName} · {formatUSD(card.unitPriceCents)} each
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Party-size changes reprice the order —{' '}
        <Link href={`/orders/${card.orderId}`} className="font-medium text-slate-700 underline underline-offset-2 hover:text-slate-900">
          make them on the full order
        </Link>
        .
      </p>

      {canWrite ? (
        !open ? (
          <button
            type="button"
            ref={triggerRef}
            onClick={() => setOpen(true)}
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add fuel / charge
          </button>
        ) : (
          <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <label htmlFor={ids.amount} className="text-xs font-medium text-slate-600">
                Amount
                <div className="mt-0.5 flex items-center rounded-md border border-slate-300 bg-white px-2 focus-within:border-slate-500 focus-within:ring-1 focus-within:ring-slate-500">
                  <span className="text-slate-500">$</span>
                  <input
                    id={ids.amount}
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-20 border-0 bg-transparent py-1.5 pl-1 text-sm focus:outline-none focus:ring-0"
                    autoFocus
                  />
                </div>
              </label>
              <label htmlFor={ids.category} className="text-xs font-medium text-slate-600">
                For
                <select
                  id={ids.category}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="mt-0.5 block rounded-md border border-slate-300 bg-white py-1.5 pl-2 pr-7 text-sm"
                >
                  {CHARGE_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label htmlFor={ids.note} className="block text-xs font-medium text-slate-600">
              Note (optional)
              <input
                id={ids.note}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={200}
                placeholder="e.g. half tank"
                className="mt-0.5 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
              />
            </label>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                disabled={pending || parsedCents <= 0}
                onClick={submit}
                className="inline-flex min-h-9 items-center rounded-md bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                Add charge{parsedCents > 0 ? ` ${formatUSD(parsedCents)}` : ''}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className="inline-flex min-h-9 items-center rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )
      ) : null}
    </section>
  );
}

/** Paid vs due, collect balance, and the (confirmed) cancel path. */
function MoneySection({
  card,
  pending,
  canWrite,
  run,
}: {
  card: ReservationCardData;
  pending: boolean;
  canWrite: boolean;
  run: RunFn;
}) {
  const [showCancel, setShowCancel] = useState(false);
  const [reason, setReason] = useState('');
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);
  const cancelPanelRef = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const cancelTitleId = useId();

  useEffect(() => {
    if (showCancel) cancelPanelRef.current?.focus();
  }, [showCancel]);

  return (
    <section aria-label="Money">
      <SectionHeading>Money</SectionHeading>
      <dl className="mt-1.5 space-y-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-slate-600">Total</dt>
          <dd className="font-medium tabular-nums text-slate-900">{formatUSD(card.totalCents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-600">Paid</dt>
          <dd className="tabular-nums text-slate-700">{formatUSD(card.amountPaidCents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-600">Balance due</dt>
          <dd
            className={cn(
              'font-semibold tabular-nums',
              card.balanceDueCents > 0 ? 'text-rose-700' : 'text-emerald-700',
            )}
          >
            {card.balanceDueCents > 0 ? formatUSD(card.balanceDueCents) : 'Paid in full'}
          </dd>
        </div>
      </dl>

      {canWrite && card.balanceDueCents > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run('Charged the card on file.', () =>
                collectBalanceAction({ orderId: card.orderId, method: 'CARD' }),
              )
            }
            className="inline-flex min-h-9 items-center rounded-md bg-slate-900 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Charge card ({formatUSD(card.balanceDueCents)})
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run('Marked paid in cash.', () =>
                collectBalanceAction({ orderId: card.orderId, method: 'CASH' }),
              )
            }
            className="inline-flex min-h-9 items-center rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Mark paid (cash)
          </button>
        </div>
      ) : null}

      {canWrite ? (
        <div className="mt-3 border-t border-slate-100 pt-3">
          {!showCancel ? (
            <button
              type="button"
              ref={cancelTriggerRef}
              aria-expanded={showCancel}
              onClick={() => setShowCancel(true)}
              className="text-xs font-medium text-rose-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
            >
              Cancel this reservation…
            </button>
          ) : (
            <div
              ref={cancelPanelRef}
              role="group"
              aria-labelledby={cancelTitleId}
              tabIndex={-1}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setShowCancel(false);
                  cancelTriggerRef.current?.focus();
                }
              }}
              className="rounded-lg border border-rose-200 bg-rose-50/60 p-3"
            >
              <p id={cancelTitleId} className="text-sm font-medium text-rose-900">
                Cancel this order?
              </p>
              <p className="mt-1 text-xs text-rose-700">
                Cancels every item on {card.orderNumber} and frees its capacity. Refunds (if owed)
                are then issued from the full order page.
              </p>
              <label htmlFor={reasonId} className="mt-2 block text-xs font-medium text-slate-600">
                Reason (optional)
              </label>
              <textarea
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder="e.g. Guest called to cancel"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-slate-500"
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(
                      'Order cancelled.',
                      () => cancelOrderAction({ orderId: card.orderId, reason }),
                      () => setShowCancel(false),
                    )
                  }
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-rose-700 px-3 text-sm font-semibold text-white hover:bg-rose-800 disabled:opacity-50"
                >
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  Confirm cancellation
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setShowCancel(false);
                    cancelTriggerRef.current?.focus();
                  }}
                  className="inline-flex min-h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100"
                >
                  Keep booking
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** Waiver state + the existing copy-link / QR distribution controls. */
function WaiverSection({ card }: { card: ReservationCardData }) {
  const guest = `${card.customer.firstName} ${card.customer.lastName}`.trim();
  return (
    <section aria-label="Waiver">
      <SectionHeading>Waiver</SectionHeading>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {card.waiverSigned ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
            <Check className="h-3 w-3" aria-hidden /> Waiver signed
          </span>
        ) : (
          <>
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
              Waiver needed
            </span>
            <SignLinkActions signUrl={card.waiverSignUrl} label={guest} compact />
          </>
        )}
      </div>
    </section>
  );
}

/** Staff notes on the order (the Note model the POS already writes). */
function NotesSection({
  card,
  pending,
  canWrite,
  run,
}: {
  card: ReservationCardData;
  pending: boolean;
  canWrite: boolean;
  run: RunFn;
}) {
  const [draft, setDraft] = useState('');
  const fieldId = useId();

  return (
    <section aria-label="Notes">
      <SectionHeading>Notes</SectionHeading>
      {card.notes.length === 0 ? (
        <p className="mt-1.5 text-sm text-slate-500">No notes yet.</p>
      ) : (
        <ul className="mt-1.5 space-y-2">
          {card.notes.map((n) => (
            <li key={n.id} className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="whitespace-pre-wrap text-sm text-slate-700">{n.content}</p>
              <p className="mt-1 text-xs text-slate-500">{formatRelative(n.createdAtISO)}</p>
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <div className="mt-2">
          <label htmlFor={fieldId} className="sr-only">
            Add a note to this order
          </label>
          <textarea
            id={fieldId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Add a note for the crew…"
            className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-slate-500 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <button
            type="button"
            disabled={pending || !draft.trim()}
            onClick={() =>
              run(
                'Note added.',
                () => addOrderNote({ orderId: card.orderId, content: draft }),
                () => setDraft(''),
              )
            }
            className="mt-1 inline-flex min-h-9 items-center rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Add note
          </button>
        </div>
      ) : null}
    </section>
  );
}
