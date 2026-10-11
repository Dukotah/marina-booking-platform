import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getTenantDb, requirePermission, getOperatorContext } from '../../../../lib/session';
import { formatDate, formatTime, formatDateTime } from '../../../../lib/format';
import { PrintButton } from '../../../../components/orders/PrintButton';

export const dynamic = 'force-dynamic';

/** One stored per-clause acknowledgment (matches the API's StoredAcknowledgment). */
interface StoredAcknowledgment {
  clauseId: string;
  title: string;
  initials: string | null;
  acknowledgedAt: string;
}

function toAcks(value: unknown): StoredAcknowledgment[] {
  return Array.isArray(value) ? (value as StoredAcknowledgment[]) : [];
}

/**
 * Print-optimized waiver packet for an order — the headline check-in artifact.
 *
 * Renders the full signed record for the WHOLE party: every signature with its
 * immutable snapshot HTML, per-clause initials, signer + guardian + DOB + IP +
 * timestamp, and the reservation/party details. Staff print this (screen chrome is
 * hidden under `@media print`) to send on the boat, supplementing the CA Boater
 * Card. Data is read through the tenant-scoped client (RLS), so a wrong-tenant id
 * simply 404s.
 */
export default async function WaiverPacketPage({
  params,
}: {
  params: { orderId: string };
}) {
  await requirePermission('order:read');
  const [db, { operatorId }] = await Promise.all([getTenantDb(), getOperatorContext()]);

  const [operator, order] = await Promise.all([
    db.operator.findUnique({
      where: { id: operatorId },
      select: { name_external: true },
    }),
    db.order.findFirst({
      where: { id: params.orderId },
      select: {
        id: true,
        order_number: true,
        created_at: true,
        customer: {
          select: { first_name: true, last_name: true, email: true, phone: true },
        },
      },
    }),
  ]);

  if (!order) notFound();

  const signatures = await db.waiverSignature.findMany({
    where: { order_item: { order_id: order.id } },
    orderBy: { signed_at: 'asc' },
    include: {
      waiver: { select: { name: true, version: true } },
      order_item: {
        select: {
          activity: { select: { name_external: true } },
          rate: { select: { name_external: true } },
          timeslot: { select: { datetime: true } },
        },
      },
    },
  });

  const operatorName = operator?.name_external ?? 'Boat Livery';
  const customerName =
    [order.customer.first_name, order.customer.last_name].filter(Boolean).join(' ') || 'Guest';

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 print:px-0 print:py-0">
      {/* Screen-only toolbar — hidden when printing. */}
      <div className="mb-6 flex items-center justify-between print:hidden">
        <Link
          href={`/orders/${order.id}`}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-ink-body hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to order
        </Link>
        <PrintButton />
      </div>

      <article className="waiver-packet space-y-6 text-slate-900">
        {/* Header */}
        <header className="border-b border-slate-300 pb-4">
          <h1 className="text-2xl font-bold">{operatorName}</h1>
          <p className="text-sm text-slate-600">Liability Waiver Packet</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <Row label="Order" value={order.order_number} />
            <Row label="Placed" value={formatDateTime(order.created_at)} />
            <Row label="Guest" value={customerName} />
            {order.customer.email ? <Row label="Email" value={order.customer.email} /> : null}
            {order.customer.phone ? <Row label="Phone" value={order.customer.phone} /> : null}
            <Row label="Signatures on file" value={String(signatures.length)} />
          </dl>
        </header>

        {/* Safety banner */}
        <section className="rounded-md border border-slate-300 bg-slate-50 p-3 text-xs leading-relaxed text-slate-700 print:bg-white">
          <p className="font-semibold">Boating safety</p>
          <p>
            This packet supplements the California Boater Card. Children under 13 must wear a
            USCG-approved life jacket (PFD) while aboard. Operate at a safe speed, obey no-wake
            zones, and do not operate under the influence of alcohol or drugs.
          </p>
        </section>

        {signatures.length === 0 ? (
          <p className="text-sm text-slate-500">
            No waiver signatures have been captured for this order yet.
          </p>
        ) : (
          signatures.map((s, idx) => {
            const acks = toAcks(s.acknowledgments);
            return (
              <section
                key={s.id}
                className="break-inside-avoid rounded-lg border border-slate-300 p-4 print:break-after-page"
              >
                <div className="mb-3 flex items-baseline justify-between border-b border-slate-200 pb-2">
                  <h2 className="text-lg font-semibold">
                    Signature {idx + 1}: {s.signer_name}
                  </h2>
                  <span className="text-xs text-slate-500">
                    {s.waiver?.name}
                    {s.waiver_version != null ? ` (v${s.waiver_version})` : ''}
                  </span>
                </div>

                <dl className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                  {s.order_item?.activity ? (
                    <Row label="Activity" value={s.order_item.activity.name_external} />
                  ) : null}
                  {s.order_item?.rate ? (
                    <Row label="Rate" value={s.order_item.rate.name_external} />
                  ) : null}
                  {s.order_item?.timeslot ? (
                    <Row
                      label="Reservation"
                      value={`${formatDate(s.order_item.timeslot.datetime)} · ${formatTime(
                        s.order_item.timeslot.datetime,
                      )}`}
                    />
                  ) : null}
                  <Row label="Signed" value={formatDateTime(s.signed_at)} />
                  {s.signer_dob ? (
                    <Row label="Date of birth" value={formatDate(s.signer_dob)} />
                  ) : null}
                  {s.is_minor ? <Row label="Minor" value="Yes" /> : null}
                  {s.guardian_name ? <Row label="Guardian" value={s.guardian_name} /> : null}
                  {s.ip_address ? <Row label="IP address" value={s.ip_address} /> : null}
                </dl>

                {/* Immutable legal record: the exact text + initials agreed to. */}
                {s.snapshot_html ? (
                  <div
                    className="prose prose-sm max-w-none border-t border-slate-200 pt-3 text-slate-800"
                    dangerouslySetInnerHTML={{ __html: s.snapshot_html }}
                  />
                ) : (
                  <p className="border-t border-slate-200 pt-3 text-xs italic text-slate-500">
                    No stored snapshot for this signature (legacy record).
                  </p>
                )}

                {/* Per-clause acknowledgment summary. */}
                {acks.length > 0 ? (
                  <div className="mt-3 border-t border-slate-200 pt-3">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Acknowledgments
                    </p>
                    <ul className="space-y-0.5 text-sm">
                      {acks.map((a) => (
                        <li key={a.clauseId} className="flex justify-between gap-4">
                          <span className="text-slate-700">{a.title}</span>
                          <span className="font-mono font-semibold text-slate-900">
                            {a.initials ?? '—'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            );
          })
        )}
      </article>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-900">{value}</dd>
    </>
  );
}
