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
  MessageSquare,
  Pencil,
  Phone,
  Plus,
  RotateCcw,
  Send,
  UserX,
  Users,
  X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { formatRelative, formatUSD } from '../../lib/format';
import { Button, Badge, type BadgeTone } from '../ui';
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
  previewCancellationRefund,
  type RefundPreview,
} from '../../app/orders/actions';
import {
  addOrderNote,
  listRescheduleSlots,
  loadReservationCard,
  messageGuestAction,
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
        className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-line bg-surface shadow-xl focus:outline-none"
      >
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>

        {/* Header */}
        <div className="relative shrink-0 border-b border-line px-5 py-4">
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-1"
            style={{ backgroundColor: card?.activityColor ?? '#94a3b8' }}
          />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id={titleId} className="truncate text-base font-semibold text-ink">
                {card ? card.activityName : 'Reservation'}
              </h2>
              {card ? (
                <p className="mt-0.5 text-sm text-ink-body">
                  <span className="font-medium tabular-nums text-ink">
                    {card.dayLabel} · {card.timeLabel}
                  </span>
                  <span className="mx-1.5 text-line-strong">|</span>
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
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
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
            <p className="flex items-center gap-2 py-8 text-sm text-ink-muted">
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
                <p className="rounded-lg bg-surface-muted px-3 py-2 text-sm text-ink-body">
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

              <MessageGuestSection card={card} pending={pending} canWrite={canWrite} run={run} />

              <NotesSection card={card} pending={pending} canWrite={Boolean(card.canWrite)} run={run} />
            </div>
          )}
        </div>

        {/* Footer */}
        {card ? (
          <div className="shrink-0 border-t border-line bg-surface-muted px-5 py-3">
            <Link
              href={`/orders/${card.orderId}`}
              className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-accent hover:text-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
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
    <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{children}</h3>
  );
}

function StatusPill({ status }: { status: ReservationCardData['itemStatus'] }) {
  // Status color law: UPCOMING + COMPLETED are quiet slate, CHECKED_IN is success,
  // NO_SHOW/CANCELLED are muted. No sky.
  const map: Record<string, { label: string; tone: BadgeTone }> = {
    UPCOMING: { label: 'Upcoming', tone: 'neutral' },
    CHECKED_IN: { label: 'Checked in', tone: 'success' },
    NO_SHOW: { label: 'No-show', tone: 'cancelled' },
    CANCELLED: { label: 'Cancelled', tone: 'owed' },
    COMPLETED: { label: 'Completed', tone: 'cancelled' },
  };
  const s = map[status] ?? { label: status, tone: 'neutral' as BadgeTone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
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
        <Button
          variant="primary"
          disabled={pending}
          onClick={() => run(`Checked in ${name}.`, () => checkInOrderItem(card.orderItemId))}
        >
          <Check className="h-4 w-4" aria-hidden /> Check in
        </Button>
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() =>
            run(`Marked ${name} as a no-show.`, () => markNoShowOrderItem(card.orderItemId))
          }
        >
          <UserX className="h-4 w-4" aria-hidden /> No-show
        </Button>
      </div>
    );
  }
  if (card.itemStatus === 'CHECKED_IN' || card.itemStatus === 'NO_SHOW') {
    const isCheckIn = card.itemStatus === 'CHECKED_IN';
    return (
      <div>
        <Button
          variant="secondary"
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
        >
          <RotateCcw className="h-4 w-4" aria-hidden />
          {isCheckIn ? 'Undo check-in' : 'Undo no-show'}
        </Button>
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
    'mt-0.5 block w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus';

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
            className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-ink-body hover:bg-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
          </button>
        ) : null}
      </div>

      {!editing ? (
        <div className="mt-1.5">
          <p className="text-base font-medium text-ink">
            {card.customer.firstName} {card.customer.lastName}
          </p>
          <p className="mt-0.5 text-sm text-ink-body">{card.customer.email}</p>
          {card.customer.phone ? (
            <a
              href={`tel:${card.customer.phone}`}
              className="mt-0.5 inline-flex items-center gap-1 text-sm text-ink-body hover:text-ink"
            >
              <Phone className="h-3.5 w-3.5" aria-hidden /> {card.customer.phone}
            </a>
          ) : (
            <p className="mt-0.5 text-sm text-ink-muted">No phone on file</p>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-2 rounded-lg border border-line bg-surface-muted p-3">
          <div className="grid grid-cols-2 gap-2">
            <label htmlFor={ids.first} className="text-xs font-medium text-ink-body">
              First name
              <input id={ids.first} ref={firstFieldRef} value={first} onChange={(e) => setFirst(e.target.value)} className={inputCls} />
            </label>
            <label htmlFor={ids.last} className="text-xs font-medium text-ink-body">
              Last name
              <input id={ids.last} value={last} onChange={(e) => setLast(e.target.value)} className={inputCls} />
            </label>
          </div>
          <label htmlFor={ids.email} className="block text-xs font-medium text-ink-body">
            Email
            <input id={ids.email} type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
          </label>
          <label htmlFor={ids.phone} className="block text-xs font-medium text-ink-body">
            Phone
            <input id={ids.phone} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(707) 555-0100" className={inputCls} />
          </label>
          <div className="flex gap-2 pt-1">
            <Button
              variant="primary"
              size="sm"
              disabled={pending || !first.trim() || !last.trim() || !email.trim()}
              onClick={save}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Save
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                editTriggerRef.current?.focus();
              }}
            >
              Cancel
            </Button>
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
        <p className="text-sm text-ink-body">
          <span className="font-semibold tabular-nums text-ink">
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
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line px-3 text-xs font-medium text-ink-body hover:bg-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <CalendarClock className="h-3.5 w-3.5" aria-hidden />
            {open ? 'Close' : 'Reschedule'}
          </button>
        ) : null}
      </div>

      {open ? (
        <div id={panelId} className="mt-2 rounded-lg border border-line bg-surface-muted p-3">
          {slotsError ? (
            <p role="alert" className="text-sm font-medium text-rose-700">
              {slotsError}
            </p>
          ) : slots === null ? (
            <p className="flex items-center gap-2 text-sm text-ink-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading available times…
            </p>
          ) : slots.length === 0 ? (
            <p className="text-sm text-ink-body">No upcoming timeslots for this activity.</p>
          ) : (
            <>
              <p className="text-xs text-ink-body">
                Pick a new time for this {card.quantity}-guest booking. Full slots are disabled.
              </p>
              <div className="mt-2 max-h-64 space-y-3 overflow-y-auto pr-1">
                {groups.map((g) => (
                  <div key={g.day}>
                    <p className="text-xs font-semibold text-ink">{g.day}</p>
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
                              'min-h-11 rounded-lg border px-2.5 text-xs font-medium tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                              isSelected
                                ? 'border-accent bg-accent text-white'
                                : disabled
                                  ? 'cursor-not-allowed border-line bg-surface-muted text-ink-muted'
                                  : 'border-line bg-surface text-ink-body hover:border-line-strong hover:bg-surface-muted',
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
                <Button
                  variant="primary"
                  size="sm"
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
                >
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  {selected ? `Move to ${selected.dayLabel} · ${selected.timeLabel}` : 'Pick a time'}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  Keep current time
                </Button>
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
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-body">
        <span className="inline-flex items-center gap-1 font-medium text-ink">
          <Users className="h-4 w-4 text-ink-muted" aria-hidden /> {card.quantity}{' '}
          {card.quantity === 1 ? 'guest' : 'guests'}
        </span>
        <span>
          {card.rateName} · {formatUSD(card.unitPriceCents)} each
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        Party-size changes reprice the order —{' '}
        <Link href={`/orders/${card.orderId}`} className="font-medium text-accent underline underline-offset-2 hover:text-accent-hover">
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
            className="mt-2 inline-flex min-h-11 items-center gap-1 rounded-lg border border-line px-3 text-xs font-medium text-ink-body hover:bg-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add fuel / charge
          </button>
        ) : (
          <div className="mt-2 space-y-2 rounded-lg border border-line bg-surface-muted p-3">
            <div className="flex flex-wrap items-end gap-2">
              <label htmlFor={ids.amount} className="text-xs font-medium text-ink-body">
                Amount
                <div className="mt-0.5 flex items-center rounded-lg border border-line bg-surface px-2 focus-within:border-accent focus-within:ring-1 focus-within:ring-focus">
                  <span className="text-ink-muted">$</span>
                  <input
                    id={ids.amount}
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-20 border-0 bg-transparent py-2 pl-1 text-sm focus:outline-none focus:ring-0"
                    autoFocus
                  />
                </div>
              </label>
              <label htmlFor={ids.category} className="text-xs font-medium text-ink-body">
                For
                <select
                  id={ids.category}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="mt-0.5 block rounded-lg border border-line bg-surface py-2 pl-2 pr-7 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus"
                >
                  {CHARGE_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label htmlFor={ids.note} className="block text-xs font-medium text-ink-body">
              Note (optional)
              <input
                id={ids.note}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={200}
                placeholder="e.g. half tank"
                className="mt-0.5 block w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus"
              />
            </label>
            <div className="flex gap-2 pt-1">
              <Button
                variant="primary"
                size="sm"
                disabled={pending || parsedCents <= 0}
                onClick={submit}
              >
                Add charge{parsedCents > 0 ? ` ${formatUSD(parsedCents)}` : ''}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                Cancel
              </Button>
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
  const [preview, setPreview] = useState<RefundPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);
  const cancelPanelRef = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const cancelTitleId = useId();

  useEffect(() => {
    if (showCancel) cancelPanelRef.current?.focus();
  }, [showCancel]);

  // Load the computed refund when the cancel panel opens, so staff see exactly
  // what the policy would refund BEFORE they confirm. Read-only; re-opening
  // re-reads in case money changed meanwhile.
  useEffect(() => {
    if (!showCancel) {
      setPreview(null);
      return;
    }
    let live = true;
    setPreviewLoading(true);
    setPreview(null);
    void previewCancellationRefund({ orderId: card.orderId }).then((res) => {
      if (!live) return;
      setPreview(res);
      setPreviewLoading(false);
    });
    return () => {
      live = false;
    };
  }, [showCancel, card.orderId, card.amountPaidCents, card.totalCents]);

  return (
    <section aria-label="Money">
      <SectionHeading>Money</SectionHeading>
      <dl className="mt-1.5 space-y-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-ink-body">Total</dt>
          <dd className="font-medium tabular-nums text-ink">{formatUSD(card.totalCents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-body">Paid</dt>
          <dd className="tabular-nums text-ink-body">{formatUSD(card.amountPaidCents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-body">Balance due</dt>
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
          <Button
            variant="primary"
            size="sm"
            disabled={pending}
            onClick={() =>
              run('Charged the card on file.', () =>
                collectBalanceAction({ orderId: card.orderId, method: 'CARD' }),
              )
            }
          >
            Charge card ({formatUSD(card.balanceDueCents)})
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() =>
              run('Marked paid in cash.', () =>
                collectBalanceAction({ orderId: card.orderId, method: 'CASH' }),
              )
            }
          >
            Mark paid (cash)
          </Button>
        </div>
      ) : null}

      {canWrite ? (
        <div className="mt-3 border-t border-line pt-3">
          {!showCancel ? (
            <button
              type="button"
              ref={cancelTriggerRef}
              aria-expanded={showCancel}
              onClick={() => setShowCancel(true)}
              className="inline-flex min-h-11 items-center text-xs font-medium text-rose-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
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
                Cancels every item on {card.orderNumber} and frees its capacity.
              </p>

              <RefundPreviewLine loading={previewLoading} preview={preview} />

              <label htmlFor={reasonId} className="mt-2 block text-xs font-medium text-ink-body">
                Reason (optional)
              </label>
              <textarea
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder="e.g. Guest called to cancel"
                className="mt-1 w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-sm placeholder:text-ink-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus"
              />
              <div className="mt-2 flex gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    run(
                      'Order cancelled.',
                      () => cancelOrderAction({ orderId: card.orderId, reason }),
                      () => setShowCancel(false),
                    )
                  }
                >
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  Confirm cancellation
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    setShowCancel(false);
                    cancelTriggerRef.current?.focus();
                  }}
                >
                  Keep booking
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The computed refund staff see before they confirm a cancel — "$X will be
 * refunded (50% tier, minus $Y fee)". Reads the shared cancellation calculator via
 * previewCancellationRefund; purely informational, so a failed read degrades to a
 * quiet note rather than blocking the cancel.
 */
function RefundPreviewLine({
  loading,
  preview,
}: {
  loading: boolean;
  preview: RefundPreview | null;
}) {
  if (loading) {
    return (
      <p className="mt-2 flex items-center gap-2 rounded-lg border border-rose-200 bg-surface px-3 py-2 text-xs text-ink-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Checking the refund…
      </p>
    );
  }
  if (!preview) return null;
  if (!preview.ok || preview.refundCents === undefined) {
    return (
      <p className="mt-2 rounded-lg border border-rose-200 bg-surface px-3 py-2 text-xs text-ink-body">
        {preview.message ?? 'Refund will be calculated when you cancel.'}
      </p>
    );
  }

  const refund = preview.refundCents;
  const fee = preview.feeCents ?? 0;
  const tier = preview.tierPercent ?? 0;

  const detail: string[] = [`${tier}% tier`];
  if (fee > 0) detail.push(`minus ${formatUSD(fee)} fee`);

  return (
    <p
      className="mt-2 rounded-lg border border-rose-200 bg-surface px-3 py-2 text-sm text-ink"
      aria-live="polite"
    >
      {refund > 0 ? (
        <>
          <span className="font-semibold tabular-nums text-emerald-700">{formatUSD(refund)}</span>{' '}
          will be refunded{' '}
          <span className="text-ink-body">({detail.join(', ')})</span>.
        </>
      ) : (
        <>
          <span className="font-semibold text-ink">No refund</span> at this time{' '}
          <span className="text-ink-body">({detail.join(', ')})</span>.
        </>
      )}
    </p>
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
          <Badge tone="success">
            <Check className="h-3 w-3" aria-hidden /> Waiver signed
          </Badge>
        ) : (
          <>
            <Badge tone="waiver">Waiver needed</Badge>
            <SignLinkActions signUrl={card.waiverSignUrl} label={guest} compact />
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Message this one guest a free-text note by email and/or SMS (the "Message
 * guest" surface). Goes through messageGuestAction → the API's message choke
 * points; email is on by default, SMS is opt-in and disabled when no phone is on
 * file. order:write, so it rides the shared canWrite gate.
 */
function MessageGuestSection({
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
  const [body, setBody] = useState('');
  const [email, setEmail] = useState(true);
  const [sms, setSms] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fieldId = useId();
  const hasPhone = Boolean(card.customer.phone);
  const guest = `${card.customer.firstName} ${card.customer.lastName}`.trim() || 'guest';

  if (!canWrite) return null;

  return (
    <section aria-label="Message guest">
      <SectionHeading>Message guest</SectionHeading>
      {!open ? (
        <button
          type="button"
          ref={triggerRef}
          onClick={() => setOpen(true)}
          className="mt-1.5 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line px-3 text-xs font-medium text-ink-body hover:bg-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <MessageSquare className="h-3.5 w-3.5" aria-hidden /> Message {card.customer.firstName || 'guest'}
        </button>
      ) : (
        <div className="mt-2 space-y-2 rounded-lg border border-line bg-surface-muted p-3">
          <label htmlFor={fieldId} className="block text-xs font-medium text-ink-body">
            Message to {guest}
            <textarea
              id={fieldId}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              maxLength={1000}
              autoFocus
              placeholder="e.g. Heads up — we're on a short weather hold, back on the water by 2:30."
              className="mt-0.5 block w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus"
            />
          </label>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium text-ink-body">
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={email}
                onChange={(e) => setEmail(e.target.checked)}
                className="h-4 w-4 rounded border-line-strong text-accent accent-accent focus:ring-focus"
              />
              Email
            </label>
            <label
              className={cn(
                'inline-flex min-h-11 items-center gap-1.5',
                hasPhone ? 'cursor-pointer' : 'cursor-not-allowed text-ink-muted',
              )}
              title={hasPhone ? undefined : 'No phone on file'}
            >
              <input
                type="checkbox"
                checked={sms && hasPhone}
                disabled={!hasPhone}
                onChange={(e) => setSms(e.target.checked)}
                className="h-4 w-4 rounded border-line-strong text-accent accent-accent focus:ring-focus disabled:opacity-50"
              />
              Text {hasPhone ? '' : '(no phone)'}
            </label>
          </div>
          <div className="flex gap-2 pt-1">
            <Button
              variant="primary"
              size="sm"
              disabled={pending || !body.trim() || (!email && !(sms && hasPhone))}
              onClick={() =>
                run(
                  `Message sent to ${guest}.`,
                  () =>
                    messageGuestAction({
                      orderId: card.orderId,
                      body,
                      email,
                      sms: sms && hasPhone,
                    }),
                  () => {
                    setOpen(false);
                    setBody('');
                    triggerRef.current?.focus();
                  },
                )
              }
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
              Send message
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
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
        <p className="mt-1.5 text-sm text-ink-muted">No notes yet.</p>
      ) : (
        <ul className="mt-1.5 space-y-2">
          {card.notes.map((n) => (
            <li key={n.id} className="rounded-lg bg-surface-muted px-3 py-2">
              <p className="whitespace-pre-wrap text-sm text-ink-body">{n.content}</p>
              <p className="mt-1 text-xs text-ink-muted">{formatRelative(n.createdAtISO)}</p>
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
            className="w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-sm placeholder:text-ink-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus"
          />
          <Button
            variant="secondary"
            size="sm"
            className="mt-1"
            disabled={pending || !draft.trim()}
            onClick={() =>
              run(
                'Note added.',
                () => addOrderNote({ orderId: card.orderId, content: draft }),
                () => setDraft(''),
              )
            }
          >
            Add note
          </Button>
        </div>
      ) : null}
    </section>
  );
}
