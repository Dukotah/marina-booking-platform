import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  User,
  Mail,
  Phone,
  ShieldCheck,
  ShieldAlert,
  CreditCard,
} from 'lucide-react';
import type { Permission } from '@marina/types';
import { AdminShell } from '../../../components/shell/AdminShell';
import { PageHeader } from '../../../components/shell/PageHeader';
import { DataTable, type Column } from '../../../components/shell/DataTable';
import {
  OrderStatusBadge,
  type OrderStatusValue,
} from '../../../components/orders/OrderStatusBadge';
import {
  PaymentStatusBadge,
  type PaymentStatusValue,
} from '../../../components/orders/PaymentStatusBadge';
import { OrderTimeline, type TimelineEvent } from '../../../components/orders/OrderTimeline';
import {
  OrderActions,
  type RefundablePayment,
} from '../../../components/orders/OrderActions';
import {
  getTenantDb,
  requirePermission,
  currentPermissions,
} from '../../../lib/session';
import { formatUSD, formatDateTime, formatDate, formatTime } from '../../../lib/format';

export const dynamic = 'force-dynamic';

const ITEM_STATUS_LABELS: Record<string, string> = {
  UPCOMING: 'Upcoming',
  CHECKED_IN: 'Checked in',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
};

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CARD: 'Card',
  CASH: 'Cash',
  GIFT_CARD: 'Gift card',
  COMP: 'Comp',
};

interface PaymentRow {
  id: string;
  method: string;
  status: PaymentStatusValue;
  amountCents: number;
  refundedCents: number;
  cardLabel: string | null;
  processedAt: Date;
}

interface ItemRow {
  id: string;
  activity: string;
  rate: string;
  quantity: number;
  unitPriceCents: number;
  status: string;
  datetime: Date;
  waiverSigned: boolean;
  waiverRequired: boolean;
}

/**
 * Order detail — the operational heart of order management. Shows the full
 * order: customer, line items, payments, waiver status, a complete event
 * timeline, and one-click actions (cancel / resend email / refund) gated by RBAC.
 * Everything is read through the tenant-scoped client (RLS), so a wrong-tenant id
 * simply 404s.
 */
export default async function OrderDetailPage({
  params,
}: {
  params: { orderId: string };
}) {
  await requirePermission('order:read');
  const [db, permissions] = await Promise.all([getTenantDb(), currentPermissions()]);

  const order = await db.order.findFirst({
    where: { id: params.orderId },
    include: {
      customer: true,
      items: {
        orderBy: { created_at: 'asc' },
        include: {
          activity: { select: { name_external: true, waiver_required: true } },
          rate: { select: { name_external: true } },
          timeslot: { select: { datetime: true } },
        },
      },
      payments: { orderBy: { processed_at: 'asc' } },
      history: { orderBy: { created_at: 'desc' } },
    },
  });

  if (!order) {
    notFound();
  }

  const has = (p: Permission) => permissions.has(p);
  const canWrite = has('order:write');
  const canRefund = has('order:refund');

  const status = order.status as OrderStatusValue;
  const customerName =
    [order.customer.first_name, order.customer.last_name].filter(Boolean).join(' ') || 'Guest';

  const itemRows: ItemRow[] = order.items.map((item) => ({
    id: item.id,
    activity: item.activity.name_external,
    rate: item.rate.name_external,
    quantity: item.quantity,
    unitPriceCents: item.unit_price_cents,
    status: item.status,
    datetime: item.timeslot.datetime,
    waiverSigned: item.waiver_signed,
    waiverRequired: item.activity.waiver_required,
  }));

  const paymentRows: PaymentRow[] = order.payments.map((p) => ({
    id: p.id,
    method: p.method,
    status: p.status as PaymentStatusValue,
    amountCents: p.amount_cents,
    refundedCents: p.refunded_cents,
    cardLabel:
      p.card_brand && p.card_last_four ? `${p.card_brand} ···· ${p.card_last_four}` : null,
    processedAt: p.processed_at,
  }));

  // Payments with a remaining refundable balance feed the inline refund control.
  const refundablePayments: RefundablePayment[] = order.payments
    .filter((p) => p.amount_cents - p.refunded_cents > 0 && p.status !== 'FAILED')
    .map((p) => ({
      id: p.id,
      amountCents: p.amount_cents,
      refundedCents: p.refunded_cents,
      label:
        p.card_brand && p.card_last_four
          ? `${p.card_brand} ···· ${p.card_last_four}`
          : PAYMENT_METHOD_LABELS[p.method] ?? p.method,
    }));

  const events: TimelineEvent[] = order.history.map((e) => ({
    id: e.id,
    type: e.type,
    description: e.description,
    actor: e.actor,
    createdAt: e.created_at,
  }));

  // Waiver rollup across items that require one.
  const waiverItems = order.items.filter((i) => i.activity.waiver_required);
  const waiversSigned = waiverItems.filter((i) => i.waiver_signed).length;
  const waiverComplete = waiverItems.length > 0 && waiversSigned === waiverItems.length;

  const itemColumns: Array<Column<ItemRow>> = [
    {
      id: 'activity',
      header: 'Activity',
      cell: (row) => (
        <div className="min-w-0">
          <div className="font-medium text-slate-800">{row.activity}</div>
          <div className="text-xs text-slate-500">{row.rate}</div>
        </div>
      ),
    },
    {
      id: 'when',
      header: 'When',
      cell: (row) => (
        <div>
          <div className="text-slate-700">{formatDate(row.datetime)}</div>
          <div className="text-xs text-slate-500">{formatTime(row.datetime)}</div>
        </div>
      ),
    },
    {
      id: 'qty',
      header: 'Qty',
      align: 'right',
      cell: (row) => row.quantity,
    },
    {
      id: 'unit',
      header: 'Unit',
      align: 'right',
      cell: (row) => formatUSD(row.unitPriceCents),
    },
    {
      id: 'lineTotal',
      header: 'Line total',
      align: 'right',
      cell: (row) => (
        <span className="font-medium text-slate-800">
          {formatUSD(row.unitPriceCents * row.quantity)}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <span className="text-xs font-medium text-slate-600">
          {ITEM_STATUS_LABELS[row.status] ?? row.status}
        </span>
      ),
    },
    {
      id: 'waiver',
      header: 'Waiver',
      cell: (row) =>
        !row.waiverRequired ? (
          <span className="text-xs text-slate-400">N/A</span>
        ) : row.waiverSigned ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Signed
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Missing
          </span>
        ),
    },
  ];

  const paymentColumns: Array<Column<PaymentRow>> = [
    {
      id: 'method',
      header: 'Method',
      cell: (row) => (
        <div className="flex items-center gap-2">
          <CreditCard className="h-4 w-4 text-slate-400" aria-hidden />
          <span className="text-slate-700">
            {row.cardLabel ?? PAYMENT_METHOD_LABELS[row.method] ?? row.method}
          </span>
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => <PaymentStatusBadge status={row.status} />,
    },
    {
      id: 'amount',
      header: 'Amount',
      align: 'right',
      cell: (row) => formatUSD(row.amountCents),
    },
    {
      id: 'refunded',
      header: 'Refunded',
      align: 'right',
      cell: (row) =>
        row.refundedCents > 0 ? (
          <span className="text-amber-700">{formatUSD(row.refundedCents)}</span>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      id: 'processed',
      header: 'Processed',
      cell: (row) => <span className="text-slate-500">{formatDateTime(row.processedAt)}</span>,
    },
  ];

  return (
    <AdminShell>
      <Link
        href="/orders"
        className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to orders
      </Link>

      <PageHeader
        title={order.order_number}
        description={`Placed ${formatDateTime(order.created_at)}`}
        actions={<OrderStatusBadge status={status} />}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* Items */}
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Items
            </h2>
            <DataTable
              columns={itemColumns}
              rows={itemRows}
              getRowKey={(row) => row.id}
              emptyState="This order has no items."
            />
          </section>

          {/* Payments */}
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Payments
            </h2>
            <DataTable
              columns={paymentColumns}
              rows={paymentRows}
              getRowKey={(row) => row.id}
              emptyState="No payments recorded for this order."
            />
          </section>

          {/* Timeline */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Timeline
            </h2>
            <OrderTimeline events={events} />
          </section>
        </div>

        <div className="space-y-6">
          {/* Actions */}
          {canWrite || canRefund ? (
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
                Actions
              </h2>
              <OrderActions
                orderId={order.id}
                isCancelled={status === 'CANCELLED'}
                hasEmail={Boolean(order.customer.email)}
                canRefund={canRefund}
                canWrite={canWrite}
                refundablePayments={refundablePayments}
              />
            </section>
          ) : null}

          {/* Summary */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Summary
            </h2>
            <dl className="space-y-2 text-sm">
              <SummaryRow label="Subtotal" value={formatUSD(order.subtotal_cents)} />
              {order.discount_cents > 0 ? (
                <SummaryRow label="Discount" value={`-${formatUSD(order.discount_cents)}`} />
              ) : null}
              {order.tax_cents > 0 ? (
                <SummaryRow label="Tax" value={formatUSD(order.tax_cents)} />
              ) : null}
              {order.processing_fee_cents > 0 ? (
                <SummaryRow label="Processing fee" value={formatUSD(order.processing_fee_cents)} />
              ) : null}
              {order.tip_cents > 0 ? (
                <SummaryRow label="Tip" value={formatUSD(order.tip_cents)} />
              ) : null}
              <div className="my-2 border-t border-slate-100" />
              <SummaryRow label="Total" value={formatUSD(order.total_cents)} strong />
              <SummaryRow label="Paid" value={formatUSD(order.amount_paid_cents)} />
              <SummaryRow
                label="Balance due"
                value={formatUSD(order.balance_due_cents)}
                strong={order.balance_due_cents > 0}
                accent={order.balance_due_cents > 0 ? 'amber' : undefined}
              />
            </dl>
          </section>

          {/* Customer */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Customer
            </h2>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 text-slate-800">
                <User className="h-4 w-4 text-slate-400" aria-hidden />
                <span className="font-medium">{customerName}</span>
              </div>
              {order.customer.email ? (
                <div className="flex items-center gap-2 text-slate-600">
                  <Mail className="h-4 w-4 text-slate-400" aria-hidden />
                  <a href={`mailto:${order.customer.email}`} className="hover:underline">
                    {order.customer.email}
                  </a>
                </div>
              ) : null}
              {order.customer.phone ? (
                <div className="flex items-center gap-2 text-slate-600">
                  <Phone className="h-4 w-4 text-slate-400" aria-hidden />
                  <a href={`tel:${order.customer.phone}`} className="hover:underline">
                    {order.customer.phone}
                  </a>
                </div>
              ) : null}
              {order.is_returning_guest ? (
                <p className="pt-1 text-xs font-medium text-sky-700">Returning guest</p>
              ) : null}
            </div>
          </section>

          {/* Waiver status */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Waiver status
            </h2>
            {waiverItems.length === 0 ? (
              <p className="text-sm text-slate-500">No waiver required for this order.</p>
            ) : (
              <div
                className={
                  waiverComplete
                    ? 'flex items-center gap-2 text-sm font-medium text-emerald-700'
                    : 'flex items-center gap-2 text-sm font-medium text-amber-700'
                }
              >
                {waiverComplete ? (
                  <ShieldCheck className="h-5 w-5" aria-hidden />
                ) : (
                  <ShieldAlert className="h-5 w-5" aria-hidden />
                )}
                <span>
                  {waiversSigned} of {waiverItems.length} signed
                  {waiverComplete ? ' — all set' : ''}
                </span>
              </div>
            )}
          </section>
        </div>
      </div>
    </AdminShell>
  );
}

function SummaryRow({
  label,
  value,
  strong,
  accent,
}: {
  label: string;
  value: string;
  strong?: boolean;
  accent?: 'amber';
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd
        className={
          accent === 'amber'
            ? 'font-semibold text-amber-700'
            : strong
              ? 'font-semibold text-slate-900'
              : 'text-slate-700'
        }
      >
        {value}
      </dd>
    </div>
  );
}
