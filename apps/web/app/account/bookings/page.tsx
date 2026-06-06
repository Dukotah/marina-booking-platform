import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getBrand, brandStyle } from '@/lib/brand';
import { formatUSD, formatLongDate, formatTime, formatDateTime } from '@/lib/format';
import { getOrder, isApiError, type OrderSummary, type OrderLineItem } from '@/lib/api';
import SiteHeader from '@/components/layout/SiteHeader';
import SiteFooter from '@/components/layout/SiteFooter';
import { ManagePanel, type ManageableItem } from '../manage-panel';
import { SignOutButton } from '../sign-out-button';
import { getCustomerSession } from '../session';

export const metadata: Metadata = {
  title: 'My Reservation',
};

// Orders are never cached — always reflect the latest payment/status.
export const dynamic = 'force-dynamic';

function Shell({ children }: { children: React.ReactNode }) {
  const brand = getBrand();
  return (
    <div style={brandStyle(brand)} className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}

/** Operator contact email for support/cancellation, tenant-configurable. */
function operatorContactEmail(): string | null {
  const v = process.env.OPERATOR_CONTACT_EMAIL?.trim();
  return v ? v : null;
}

/** Customer-facing status badge styling. */
function statusBadge(status: OrderSummary['status']): { label: string; className: string } {
  switch (status) {
    case 'UPCOMING':
      return { label: 'Upcoming', className: 'bg-emerald-100 text-emerald-800' };
    case 'COMPLETED':
      return { label: 'Completed', className: 'bg-slate-100 text-slate-700' };
    case 'CANCELLED':
      return { label: 'Cancelled', className: 'bg-red-100 text-red-800' };
    case 'NO_SHOW':
      return { label: 'No show', className: 'bg-amber-100 text-amber-800' };
    default:
      return { label: status, className: 'bg-slate-100 text-slate-700' };
  }
}

/**
 * Customer bookings view. Identity comes from the httpOnly session cookie (set by
 * the OTP verify flow), not the URL. We read the order number from the session,
 * then fetch the order — the API additionally verifies the forwarded session token
 * before returning any data (see lib/api.ts request()). Missing cookie → redirect
 * back to /account to sign in. White-label throughout (operator brand only).
 */
export default async function BookingsPage() {
  const brand = getBrand();

  const session = getCustomerSession();
  if (!session) {
    redirect('/account');
  }
  const orderNumber = session.orderNumber.trim().toUpperCase();

  let order: OrderSummary | null = null;
  let networkError = false;
  try {
    order = await getOrder(orderNumber);
  } catch (err) {
    if (isApiError(err) && err.status === 0) networkError = true;
    order = null;
  }

  if (networkError) {
    return <NotAuthorized reason="network" />;
  }

  if (!order) {
    return <NotAuthorized reason="mismatch" />;
  }

  const now = Date.now();
  const upcoming: OrderLineItem[] = [];
  const past: OrderLineItem[] = [];
  for (const item of order.items) {
    const t = new Date(item.datetime).getTime();
    if (Number.isFinite(t) && t >= now) upcoming.push(item);
    else past.push(item);
  }
  const sortByTime = (a: OrderLineItem, b: OrderLineItem) =>
    new Date(a.datetime).getTime() - new Date(b.datetime).getTime();
  upcoming.sort(sortByTime);
  past.sort((a, b) => sortByTime(b, a));

  const badge = statusBadge(order.status);
  const changeable = order.status === 'UPCOMING' && upcoming.length > 0;
  // Only upcoming items are movable; map to the shape the manage panel needs.
  const manageableItems = upcoming.map((item) => ({
    id: item.id,
    activityId: item.activityId,
    activityName: item.activityName,
    rateName: item.rateName,
    datetime: item.datetime,
  }));

  return (
    <Shell>
      <div className="mx-auto flex w-full max-w-2xl flex-col px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/account" className="text-sm font-medium text-brand hover:underline">
          ← Look up another booking
        </Link>
        <SignOutButton />
      </div>

      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Reservation {order.orderNumber}
          </h1>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${badge.className}`}
          >
            {badge.label}
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Booked by {order.customerName} · {formatDateTime(order.createdAt)}
        </p>
      </header>

      <ManagePanelSection
        orderNumber={order.orderNumber}
        operatorName={brand.name}
        changeable={changeable}
        accentColor={brand.color}
        items={manageableItems}
      />

      {upcoming.length > 0 && (
        <ItemSection title="Upcoming" items={upcoming} highlight />
      )}
      {past.length > 0 && <ItemSection title="Past" items={past} />}

      <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Payment summary
        </h2>
        <dl className="space-y-2 text-sm">
          <Row label="Subtotal" value={formatUSD(order.subtotalCents)} />
          {order.discountCents > 0 && (
            <Row label="Discount" value={`−${formatUSD(order.discountCents)}`} />
          )}
          {order.taxCents > 0 && <Row label="Tax" value={formatUSD(order.taxCents)} />}
          {order.processingFeeCents > 0 && (
            <Row label="Processing fee" value={formatUSD(order.processingFeeCents)} />
          )}
          {order.tipCents > 0 && <Row label="Tip" value={formatUSD(order.tipCents)} />}
          <div className="my-2 border-t border-slate-200" />
          <Row label="Total" value={formatUSD(order.totalCents)} bold />
          <Row label="Paid" value={formatUSD(order.amountPaidCents)} />
          {order.balanceDueCents > 0 && (
            <Row
              label="Balance due"
              value={formatUSD(order.balanceDueCents)}
              emphasis
            />
          )}
        </dl>
      </section>

      <p className="mt-6 text-center text-xs text-slate-500">
        Need help? Contact {brand.name}
        {operatorContactEmail() ? (
          <>
            {' '}at{' '}
            <a
              className="font-medium text-brand hover:underline"
              href={`mailto:${operatorContactEmail()}`}
            >
              {operatorContactEmail()}
            </a>
          </>
        ) : null}
        .
      </p>
      </div>
    </Shell>
  );
}

/** Wrapper so the (client) ManagePanel gets the operator contact email. */
function ManagePanelSection(props: {
  orderNumber: string;
  operatorName: string;
  changeable: boolean;
  accentColor: string;
  items: ManageableItem[];
}) {
  return (
    <section className="mb-8">
      <ManagePanel
        orderNumber={props.orderNumber}
        operatorName={props.operatorName}
        contactEmail={operatorContactEmail()}
        changeable={props.changeable}
        accentColor={props.accentColor}
        items={props.items}
      />
    </section>
  );
}

function ItemSection({
  title,
  items,
  highlight = false,
}: {
  title: string;
  items: OrderLineItem[];
  highlight?: boolean;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h2>
      <ul className="space-y-3">
        {items.map((item) => (
          <li
            key={item.id}
            className={`rounded-2xl border bg-white p-4 shadow-sm ${
              highlight ? 'border-brand/40' : 'border-slate-200'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-slate-900">{item.activityName}</p>
                <p className="text-sm text-slate-600">{item.rateName}</p>
              </div>
              <p className="whitespace-nowrap text-sm font-medium text-slate-900">
                {item.quantity} ×{' '}
                {formatUSD(item.unitPriceCents)}
              </p>
            </div>
            <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <span className="font-medium text-slate-900">
                {formatLongDate(item.datetime)}
              </span>{' '}
              · {formatTime(item.datetime)}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({
  label,
  value,
  bold = false,
  emphasis = false,
}: {
  label: string;
  value: string;
  bold?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className={emphasis ? 'font-medium text-red-700' : 'text-slate-600'}>
        {label}
      </dt>
      <dd
        className={
          emphasis
            ? 'font-semibold text-red-700'
            : bold
              ? 'text-base font-bold text-slate-900'
              : 'text-slate-900'
        }
      >
        {value}
      </dd>
    </div>
  );
}

function NotAuthorized({ reason }: { reason: 'missing' | 'mismatch' | 'network' }) {
  const message =
    reason === 'network'
      ? 'We could not reach the booking system. Please try again in a moment.'
      : 'We could not find a booking matching that link. Please look it up again.';
  return (
    <Shell>
      <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-slate-900">Booking unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">{message}</p>
        <Link
          href="/account"
          className="mt-6 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
        >
          Look up my booking
        </Link>
      </div>
    </Shell>
  );
}
