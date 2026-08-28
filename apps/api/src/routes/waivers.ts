import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import {
  AUDIT_ACTIONS,
  SYSTEM_ACTOR,
  customerActor,
  recordAudit,
} from '../services/audit.js';
import {
  getActiveWaiverWithClauses,
  signWaiver,
  getWaiverPacket,
  WaiverError,
} from '../services/waivers-service.js';

/**
 * Waivers API. All access is automatically tenant-scoped by RLS via `c.var.db`;
 * write payloads still carry `operator_id` explicitly because the column is
 * required and not defaulted in the schema.
 *
 *   GET  /active  — public: the operator's active waiver template (for display).
 *   POST /sign    — public: capture a signature for an order item, flip the item's
 *                   waiver flags, and mark the customer's waiver as on file.
 *   GET  /        — staff (order:read): all signatures captured for an order.
 */
export const waivers = new Hono<Env>();

// Throttle the public waiver-signing endpoint per IP + tenant (public write). The
// staff GET / route below runs behind requireStaff and is not throttled.
const publicRateLimit = rateLimit();

/** One per-clause acknowledgment carried in POST /sign. */
const acknowledgmentSchema = z.object({
  clauseId: z.string().min(1),
  /** The signer's initials for this clause (required when the clause requires initials). */
  initials: z.string().trim().max(16).optional(),
});

/** Body for POST /sign — a customer (or guardian) signing a waiver for an item. */
const signWaiverSchema = z.object({
  orderItemId: z.string().min(1, 'orderItemId is required'),
  signerName: z.string().trim().min(1, 'signerName is required').max(120),
  /** ISO date string (YYYY-MM-DD or full ISO); used to flag minors + kept on record. */
  signerDob: z.string().trim().min(1).max(40).optional(),
  /** Base64 image data URL or a typed signature string. */
  signatureData: z.string().trim().min(1, 'signatureData is required').max(500_000),
  isMinor: z.boolean().default(false),
  guardianName: z.string().trim().min(1).max(120).optional(),
  /** Per-clause acknowledgments; every required clause must appear here. */
  acknowledgments: z.array(acknowledgmentSchema).default([]),
});

/** Query for GET / — which order's signatures to return. */
const orderSignaturesSchema = z.object({
  orderId: z.string().min(1, 'orderId is required'),
});

/** Query for GET /packet — which order to build the print packet for. */
const packetSchema = z.object({
  orderId: z.string().min(1, 'orderId is required'),
});

/**
 * Best-effort client IP from common proxy headers, falling back to the direct
 * peer. `x-forwarded-for` may be a comma-separated list; the first entry is the
 * original client.
 */
function clientIp(c: Context<Env>): string | null {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return c.req.header('x-real-ip')?.trim() || null;
}

/**
 * GET /active — public. Returns the tenant's active waiver template plus its
 * ordered clauses so the booking/checkout UI can render a clause-by-clause,
 * initial-each-section signing flow. `?activityId=` is accepted for a future
 * per-activity waiver mapping. If an operator has more than one active waiver, the
 * most recently created one is treated as current.
 */
waivers.get('/active', async (c) => {
  const activityId = c.req.query('activityId') || undefined;
  const waiver = await getActiveWaiverWithClauses(c.var.operatorId, activityId);

  if (!waiver) {
    return c.json({ error: 'No active waiver configured' }, 404);
  }

  return c.json({
    waiver: {
      id: waiver.id,
      name: waiver.name,
      version: waiver.version,
      introHtml: waiver.introHtml,
      // Kept as `templateHtml` for backward compatibility with existing callers.
      templateHtml: waiver.templateHtml,
      requiresMinorSignature: waiver.requiresMinorSignature,
      clauses: waiver.clauses.map((cl) => ({
        id: cl.id,
        sortOrder: cl.sortOrder,
        title: cl.title,
        bodyHtml: cl.bodyHtml,
        requiresInitials: cl.requiresInitials,
        isRequired: cl.isRequired,
      })),
    },
  });
});

/**
 * POST /sign — public. Records a WaiverSignature against an order item using the
 * tenant's active waiver template, marks the item as waiver-signed, and flags the
 * customer as having a waiver on file. Performed in a single transaction so the
 * signature and the derived flags never drift.
 */
waivers.post('/sign', publicRateLimit, async (c) => {
  const parsed = signWaiverSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }
  const { orderItemId, signerName, signerDob, signatureData, isMinor, guardianName, acknowledgments } =
    parsed.data;

  try {
    const signature = await signWaiver(c.var.operatorId, {
      orderItemId,
      signerName,
      signerDob,
      signatureData,
      isMinor,
      guardianName,
      acknowledgments,
      ipAddress: clientIp(c),
    });

    // A waiver is the one record here that a court may eventually read, so the
    // audit row carries who signed, for whom, and against which template version.
    // The signature image itself never goes in: it is the evidence, and the audit
    // log is not where a second copy of it belongs.
    const item = await c.var.db.orderItem.findFirst({
      where: { id: orderItemId },
      select: {
        order_id: true,
        order: { select: { order_number: true, customer_id: true } },
      },
    });

    await recordAudit({
      operatorId: c.var.operatorId,
      actor: item
        ? customerActor(item.order.customer_id, clientIp(c))
        : { ...SYSTEM_ACTOR, ip: clientIp(c) },
      action: AUDIT_ACTIONS.WAIVER_SIGN,
      entityType: 'WaiverSignature',
      entityId: signature.id,
      after: {
        signer_name: signature.signerName,
        signed_at: signature.signedAt,
        waiver_id: signature.waiverId,
        waiver_version: signature.waiverVersion,
        is_minor: signature.isMinor,
        guardian_name: signature.guardianName,
      },
      context: {
        order_item_id: signature.orderItemId,
        order_id: item?.order_id ?? null,
        order_number: item?.order.order_number ?? null,
        customer_id: item?.order.customer_id ?? null,
        clauses_acknowledged: signature.acknowledgments.length,
      },
    });

    return c.json(
      {
        signature: {
          id: signature.id,
          waiverId: signature.waiverId,
          waiverVersion: signature.waiverVersion,
          orderItemId: signature.orderItemId,
          signerName: signature.signerName,
          signedAt: signature.signedAt,
          isMinor: signature.isMinor,
          guardianName: signature.guardianName,
          acknowledgments: signature.acknowledgments,
        },
      },
      201,
    );
  } catch (err) {
    if (err instanceof WaiverError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400 | 404);
    }
    throw err;
  }
});

/**
 * GET /packet — staff (order:read). Returns the full signed waiver packet for an
 * order: every signature with its IMMUTABLE snapshot + per-clause acknowledgments,
 * plus reservation/party details, for the print-optimized check-in packet staff
 * send out on the boat (supplementing the CA Boater Card).
 */
waivers.get('/packet', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:read');

  const parsed = packetSchema.safeParse({ orderId: c.req.query('orderId') });
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  const packet = await getWaiverPacket(c.var.operatorId, parsed.data.orderId);
  if (!packet) {
    return c.json({ error: 'Order not found' }, 404);
  }

  return c.json({ packet });
});

/**
 * GET / — staff (order:read). Returns every waiver signature captured for the
 * items of a given order, for the staff audit trail / order detail view.
 */
waivers.get('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:read');

  const parsed = orderSignaturesSchema.safeParse({ orderId: c.req.query('orderId') });
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  const signatures = await c.var.db.waiverSignature.findMany({
    where: { order_item: { order_id: parsed.data.orderId } },
    orderBy: { signed_at: 'desc' },
    include: { waiver: { select: { id: true, name: true } } },
  });

  return c.json({
    signatures: signatures.map((s) => ({
      id: s.id,
      waiver: s.waiver ? { id: s.waiver.id, name: s.waiver.name } : null,
      orderItemId: s.order_item_id,
      customerId: s.customer_id,
      signerName: s.signer_name,
      signedAt: s.signed_at,
      ipAddress: s.ip_address,
      isMinor: s.is_minor,
      guardianName: s.guardian_name,
    })),
  });
});
