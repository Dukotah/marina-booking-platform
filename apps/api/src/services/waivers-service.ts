/**
 * Waivers service — the enriched, clause-level liability-waiver engine for
 * California boat rentals.
 *
 * A Waiver is a versioned template with an intro and an ordered list of
 * WaiverClauses (assumption of risk, liability release, rental/equipment terms,
 * boater-competency + CA Boater Card acknowledgment, alcohol policy, invasive
 * species inspection, weather, USCG PFD rules, capacity/rules of the waterway,
 * minor consent, and an optional photo/media release). Each clause can require
 * its own initials so consent is granular and legally defensible.
 *
 * The legal record is the IMMUTABLE `snapshot_html` captured on each
 * WaiverSignature: the exact intro + every clause + the per-clause initials +
 * signer + timestamp that were presented and agreed to. We NEVER regenerate a
 * snapshot from the (mutable) waiver — the stored snapshot IS the record, so a
 * later edit or version bump can't rewrite history.
 *
 * All data access is tenant-scoped via forOperator/withTenant (RLS), exactly like
 * the gift-card and resource services.
 */

import { forOperator, withTenant, type Prisma } from '@marina/database';

/** A typed, user-facing failure that route handlers map to a clean HTTP status. */
export class WaiverError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'WaiverError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Read: the active waiver + ordered clauses
// ---------------------------------------------------------------------------

export interface WaiverClauseView {
  id: string;
  sortOrder: number;
  title: string;
  bodyHtml: string;
  requiresInitials: boolean;
  isRequired: boolean;
}

export interface ActiveWaiverView {
  id: string;
  name: string;
  version: number;
  introHtml: string | null;
  templateHtml: string;
  requiresMinorSignature: boolean;
  clauses: WaiverClauseView[];
}

/**
 * The tenant's current active waiver plus its clauses in display order. If the
 * operator has more than one active waiver the most recently created wins (matches
 * the existing GET /active behavior). `activityId` is accepted for a future
 * per-activity waiver mapping; today all activities share the tenant waiver, so it
 * is validated-through but does not narrow the result.
 */
export async function getActiveWaiverWithClauses(
  operatorId: string,
  _activityId?: string,
): Promise<ActiveWaiverView | null> {
  const db = forOperator(operatorId);
  const waiver = await db.waiver.findFirst({
    where: { is_active: true },
    orderBy: { created_at: 'desc' },
    include: {
      clauses: { orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }] },
    },
  });
  if (!waiver) return null;

  return {
    id: waiver.id,
    name: waiver.name,
    version: waiver.version,
    introHtml: waiver.intro_html,
    templateHtml: waiver.template_html,
    requiresMinorSignature: waiver.requires_minor_signature,
    clauses: waiver.clauses.map((c) => ({
      id: c.id,
      sortOrder: c.sort_order,
      title: c.title,
      bodyHtml: c.body_html,
      requiresInitials: c.requires_initials,
      isRequired: c.is_required,
    })),
  };
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

export interface SignAcknowledgmentInput {
  clauseId: string;
  /** The signer's initials for this clause (required when the clause requires initials). */
  initials?: string;
}

export interface SignWaiverInput {
  orderItemId: string;
  signerName: string;
  /** ISO date string or Date; used to flag minors and preserved on the record. */
  signerDob?: string | Date;
  signatureData: string;
  isMinor: boolean;
  guardianName?: string;
  acknowledgments: SignAcknowledgmentInput[];
  ipAddress?: string | null;
}

/** One entry in the immutable acknowledgments JSON stored on the signature. */
export interface StoredAcknowledgment {
  clauseId: string;
  title: string;
  initials: string | null;
  acknowledgedAt: string;
}

export interface SignWaiverResult {
  id: string;
  waiverId: string;
  waiverVersion: number;
  orderItemId: string | null;
  signerName: string;
  signedAt: Date;
  isMinor: boolean;
  guardianName: string | null;
  acknowledgments: StoredAcknowledgment[];
  snapshotHtml: string;
}

/** Escape user-supplied text before embedding it in the immutable snapshot HTML. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build the immutable legal record: the intro, every clause (title + body) with
 * the initials captured for it, and the signer block (name, DOB, guardian, IP,
 * timestamp). This is rendered ONCE at signing and stored verbatim.
 */
function buildSnapshotHtml(args: {
  waiverName: string;
  waiverVersion: number;
  introHtml: string | null;
  templateHtml: string;
  clauses: WaiverClauseView[];
  acknowledgments: StoredAcknowledgment[];
  signerName: string;
  signerDob?: Date | null;
  isMinor: boolean;
  guardianName?: string | null;
  ipAddress?: string | null;
  signedAt: Date;
}): string {
  const initialsByClause = new Map(args.acknowledgments.map((a) => [a.clauseId, a.initials]));

  const clauseBlocks = args.clauses
    .map((c) => {
      const initials = initialsByClause.get(c.id);
      const initialsLine = c.requiresInitials
        ? `<p class="waiver-initials"><strong>Initialed:</strong> ${
            initials ? esc(initials) : '—'
          }</p>`
        : '';
      return `<section class="waiver-clause"><h3>${esc(c.title)}</h3>${c.bodyHtml}${initialsLine}</section>`;
    })
    .join('\n');

  // Fall back to the legacy single-blob body only if there are no structured clauses.
  const intro = args.introHtml ?? '';
  const body = args.clauses.length > 0 ? clauseBlocks : args.templateHtml;

  const dobLine = args.signerDob
    ? `<p><strong>Date of birth:</strong> ${esc(args.signerDob.toISOString().slice(0, 10))}</p>`
    : '';
  const guardianLine =
    args.isMinor && args.guardianName
      ? `<p><strong>Signed by guardian:</strong> ${esc(args.guardianName)} (on behalf of a minor)</p>`
      : '';
  const ipLine = args.ipAddress ? `<p><strong>IP address:</strong> ${esc(args.ipAddress)}</p>` : '';

  return [
    `<article class="waiver-snapshot" data-version="${args.waiverVersion}">`,
    `<h2>${esc(args.waiverName)}</h2>`,
    `<p class="waiver-version">Version ${args.waiverVersion}</p>`,
    intro,
    body,
    `<section class="waiver-signature-block">`,
    `<h3>Signature</h3>`,
    `<p><strong>Signed by:</strong> ${esc(args.signerName)}</p>`,
    dobLine,
    guardianLine,
    ipLine,
    `<p><strong>Signed at:</strong> ${esc(args.signedAt.toISOString())}</p>`,
    `</section>`,
    `</article>`,
  ]
    .filter(Boolean)
    .join('\n');
}

function coerceDob(value?: string | Date): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Capture a clause-level waiver signature for an order item.
 *
 * Validates that every REQUIRED clause is acknowledged (and that clauses which
 * require initials actually carry initials), builds and stores the immutable
 * snapshot + acknowledgments JSON + waiver version, flips the order item's waiver
 * flags, and marks the customer's waiver as on file — all in one tenant-scoped
 * transaction so the signature and derived flags never drift.
 */
export async function signWaiver(
  operatorId: string,
  input: SignWaiverInput,
): Promise<SignWaiverResult> {
  const active = await getActiveWaiverWithClauses(operatorId);
  if (!active) {
    throw new WaiverError('NO_ACTIVE_WAIVER', 'No active waiver configured.', 404);
  }

  const signerDob = coerceDob(input.signerDob);
  if (input.isMinor && !input.guardianName) {
    throw new WaiverError('GUARDIAN_REQUIRED', 'guardianName is required when isMinor is true.');
  }

  // Index the submitted acknowledgments by clause id (last one wins).
  const submitted = new Map<string, string | undefined>();
  for (const a of input.acknowledgments ?? []) {
    submitted.set(a.clauseId, a.initials?.trim() || undefined);
  }

  // Every required clause must be acknowledged; clauses that require initials must
  // carry non-empty initials. Optional clauses (e.g. photo/media release) may be
  // omitted. Unknown clause ids are ignored — the stored record is built strictly
  // from the active waiver's own clauses so it can't be spoofed.
  const signedAt = new Date();
  const stored: StoredAcknowledgment[] = [];
  for (const clause of active.clauses) {
    const hasEntry = submitted.has(clause.id);
    const initials = submitted.get(clause.id) ?? null;

    if (clause.isRequired && !hasEntry) {
      throw new WaiverError(
        'CLAUSE_NOT_ACKNOWLEDGED',
        `The required clause "${clause.title}" was not acknowledged.`,
      );
    }
    if (clause.isRequired && clause.requiresInitials && !initials) {
      throw new WaiverError(
        'INITIALS_REQUIRED',
        `Initials are required for the clause "${clause.title}".`,
      );
    }
    // Record every clause the signer acknowledged (required, or optional-and-present).
    if (hasEntry) {
      stored.push({
        clauseId: clause.id,
        title: clause.title,
        initials,
        acknowledgedAt: signedAt.toISOString(),
      });
    }
  }

  const snapshotHtml = buildSnapshotHtml({
    waiverName: active.name,
    waiverVersion: active.version,
    introHtml: active.introHtml,
    templateHtml: active.templateHtml,
    clauses: active.clauses,
    acknowledgments: stored,
    signerName: input.signerName,
    signerDob,
    isMinor: input.isMinor,
    guardianName: input.guardianName ?? null,
    ipAddress: input.ipAddress ?? null,
    signedAt,
  });

  return withTenant(operatorId, async (tx) => {
    const orderItem = await tx.orderItem.findFirst({
      where: { id: input.orderItemId },
      select: { id: true, order: { select: { customer_id: true } } },
    });
    if (!orderItem) {
      throw new WaiverError('ORDER_ITEM_NOT_FOUND', 'Order item not found.', 404);
    }

    const created = await tx.waiverSignature.create({
      data: {
        operator_id: operatorId,
        waiver_id: active.id,
        order_item_id: orderItem.id,
        customer_id: orderItem.order.customer_id,
        signer_name: input.signerName,
        signer_dob: signerDob,
        signed_at: signedAt,
        signature_data: input.signatureData,
        ip_address: input.ipAddress ?? null,
        is_minor: input.isMinor,
        guardian_name: input.guardianName ?? null,
        waiver_version: active.version,
        snapshot_html: snapshotHtml,
        acknowledgments: stored as unknown as Prisma.InputJsonValue,
      },
    });

    await tx.orderItem.update({
      where: { id: orderItem.id },
      data: { waiver_signed: true, waiver_signed_at: signedAt },
    });

    await tx.customer.update({
      where: { id: orderItem.order.customer_id },
      data: { waiver_on_file: true },
    });

    return {
      id: created.id,
      waiverId: created.waiver_id,
      waiverVersion: created.waiver_version ?? active.version,
      orderItemId: created.order_item_id,
      signerName: created.signer_name,
      signedAt: created.signed_at,
      isMinor: created.is_minor,
      guardianName: created.guardian_name,
      acknowledgments: stored,
      snapshotHtml,
    };
  });
}

// ---------------------------------------------------------------------------
// Packet (staff / check-in printout)
// ---------------------------------------------------------------------------

export interface WaiverPacketSignature {
  id: string;
  orderItemId: string | null;
  activityName: string | null;
  rateName: string | null;
  reservationAt: Date | null;
  signerName: string;
  signerDob: Date | null;
  signedAt: Date;
  ipAddress: string | null;
  isMinor: boolean;
  guardianName: string | null;
  waiverVersion: number | null;
  signatureData: string;
  snapshotHtml: string | null;
  acknowledgments: StoredAcknowledgment[];
}

export interface WaiverPacket {
  order: {
    id: string;
    orderNumber: string;
    createdAt: Date;
  };
  customer: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
  } | null;
  waiver: { id: string; name: string; version: number } | null;
  signatures: WaiverPacketSignature[];
}

/**
 * The full signed waiver packet for an order — every signature with its immutable
 * snapshot + acknowledgments, plus the reservation/party details needed to print a
 * legal record for the whole party at check-in. Staff-only (order:read enforced at
 * the route).
 */
export async function getWaiverPacket(
  operatorId: string,
  orderId: string,
): Promise<WaiverPacket | null> {
  const db = forOperator(operatorId);

  const order = await db.order.findFirst({
    where: { id: orderId },
    select: {
      id: true,
      order_number: true,
      created_at: true,
      customer: {
        select: { id: true, first_name: true, last_name: true, email: true, phone: true },
      },
    },
  });
  if (!order) return null;

  const signatures = await db.waiverSignature.findMany({
    where: { order_item: { order_id: orderId } },
    orderBy: { signed_at: 'asc' },
    include: {
      waiver: { select: { id: true, name: true, version: true } },
      order_item: {
        select: {
          id: true,
          activity: { select: { name_external: true } },
          rate: { select: { name_external: true } },
          timeslot: { select: { datetime: true } },
        },
      },
    },
  });

  const waiver = signatures[0]?.waiver
    ? {
        id: signatures[0].waiver.id,
        name: signatures[0].waiver.name,
        version: signatures[0].waiver.version,
      }
    : null;

  return {
    order: {
      id: order.id,
      orderNumber: order.order_number,
      createdAt: order.created_at,
    },
    customer: order.customer
      ? {
          id: order.customer.id,
          name:
            [order.customer.first_name, order.customer.last_name].filter(Boolean).join(' ') ||
            'Guest',
          email: order.customer.email,
          phone: order.customer.phone,
        }
      : null,
    waiver,
    signatures: signatures.map((s) => ({
      id: s.id,
      orderItemId: s.order_item_id,
      activityName: s.order_item?.activity?.name_external ?? null,
      rateName: s.order_item?.rate?.name_external ?? null,
      reservationAt: s.order_item?.timeslot?.datetime ?? null,
      signerName: s.signer_name,
      signerDob: s.signer_dob,
      signedAt: s.signed_at,
      ipAddress: s.ip_address,
      isMinor: s.is_minor,
      guardianName: s.guardian_name,
      waiverVersion: s.waiver_version,
      signatureData: s.signature_data,
      snapshotHtml: s.snapshot_html,
      acknowledgments: Array.isArray(s.acknowledgments)
        ? (s.acknowledgments as unknown as StoredAcknowledgment[])
        : [],
    })),
  };
}
