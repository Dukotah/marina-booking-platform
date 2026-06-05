import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { createId } from '@marina/core';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';

/**
 * Waivers API. All access is automatically tenant-scoped by RLS via `c.var.db`;
 * write payloads still carry `operator_id` explicitly because the column is
 * required and not defaulted in the schema.
 *
 *   GET  /active             — public: the operator's active waiver template (for display).
 *   POST /sign               — public: capture a signature for an order item, flip the
 *                              item's waiver flags, and mark the customer's waiver on file.
 *   GET  /                   — staff (order:read): all signatures captured for an order.
 *   GET  /templates          — staff (order:read): every waiver template version.
 *   POST /templates          — staff (operator:manage): publish a NEW template version.
 *   POST /templates/:id/activate — staff (operator:manage): make a version the active one.
 *
 * Template versioning + audit integrity: a waiver's `template_html` is treated as
 * IMMUTABLE once it exists — past `WaiverSignature` rows reference the exact version
 * the customer signed, so editing a template in place would rewrite signed legal
 * history. "Editing" is therefore publish-a-new-version: POST /templates creates a new
 * Waiver row and (by default) deactivates the prior active one; old versions are kept
 * forever for the signatures that point at them. Exactly one version is active at a time.
 */
export const waivers = new Hono<Env>();

/** Body for POST /sign — a customer (or guardian) signing a waiver for an item. */
const signWaiverSchema = z.object({
  orderItemId: z.string().min(1, 'orderItemId is required'),
  signerName: z.string().trim().min(1, 'signerName is required').max(120),
  /** Base64 image data URL or a typed signature string. */
  signatureData: z.string().trim().min(1, 'signatureData is required').max(500_000),
  isMinor: z.boolean().default(false),
  guardianName: z.string().trim().min(1).max(120).optional(),
});

/** Query for GET / — which order's signatures to return. */
const orderSignaturesSchema = z.object({
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
 * GET /active — public. Returns the tenant's active waiver template so the
 * booking/checkout UI can render it. If an operator has more than one active
 * waiver, the most recently created one is treated as current.
 */
waivers.get('/active', async (c) => {
  const waiver = await c.var.db.waiver.findFirst({
    where: { is_active: true },
    orderBy: { created_at: 'desc' },
  });

  if (!waiver) {
    return c.json({ error: 'No active waiver configured' }, 404);
  }

  return c.json({
    waiver: {
      id: waiver.id,
      name: waiver.name,
      templateHtml: waiver.template_html,
      requiresMinorSignature: waiver.requires_minor_signature,
    },
  });
});

/**
 * POST /sign — public. Records a WaiverSignature against an order item using the
 * tenant's active waiver template, marks the item as waiver-signed, and flags the
 * customer as having a waiver on file. Performed in a single transaction so the
 * signature and the derived flags never drift.
 */
waivers.post('/sign', async (c) => {
  const parsed = signWaiverSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }
  const { orderItemId, signerName, signatureData, isMinor, guardianName } = parsed.data;

  // A minor signing requires a guardian to co-sign.
  if (isMinor && !guardianName) {
    return c.json({ error: 'guardianName is required when isMinor is true' }, 400);
  }

  // Resolve the active waiver template for this tenant.
  const waiver = await c.var.db.waiver.findFirst({
    where: { is_active: true },
    orderBy: { created_at: 'desc' },
  });
  if (!waiver) {
    return c.json({ error: 'No active waiver configured' }, 404);
  }

  // Load the target order item (RLS scopes this to the current tenant) and the
  // owning order's customer so we can flag their waiver as on file.
  const orderItem = await c.var.db.orderItem.findFirst({
    where: { id: orderItemId },
    select: { id: true, order: { select: { customer_id: true } } },
  });
  if (!orderItem) {
    return c.json({ error: 'Order item not found' }, 404);
  }

  const ipAddress = clientIp(c);
  const signedAt = new Date();
  const customerId = orderItem.order.customer_id;

  const signature = await c.var.db.$transaction(async (tx) => {
    const created = await tx.waiverSignature.create({
      data: {
        id: createId(),
        operator_id: c.var.operatorId,
        waiver_id: waiver.id,
        order_item_id: orderItem.id,
        customer_id: customerId,
        signer_name: signerName,
        signed_at: signedAt,
        signature_data: signatureData,
        ip_address: ipAddress,
        is_minor: isMinor,
        guardian_name: guardianName ?? null,
      },
    });

    await tx.orderItem.update({
      where: { id: orderItem.id },
      data: { waiver_signed: true, waiver_signed_at: signedAt },
    });

    await tx.customer.update({
      where: { id: customerId },
      data: { waiver_on_file: true },
    });

    return created;
  });

  return c.json(
    {
      signature: {
        id: signature.id,
        waiverId: signature.waiver_id,
        orderItemId: signature.order_item_id,
        signerName: signature.signer_name,
        signedAt: signature.signed_at,
        isMinor: signature.is_minor,
        guardianName: signature.guardian_name,
      },
    },
    201,
  );
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

// --- Template management ---------------------------------------------------

/** Body for POST /templates — publish a new waiver template version. */
const createTemplateSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(160),
  templateHtml: z.string().trim().min(1, 'templateHtml is required').max(200_000),
  requiresMinorSignature: z.boolean().default(true),
  /** Make this the active version on create (deactivating the prior one). Default true. */
  activate: z.boolean().default(true),
});

interface WaiverTemplateRow {
  id: string;
  name: string;
  template_html: string;
  requires_minor_signature: boolean;
  is_active: boolean;
  created_at: Date;
}

function serializeTemplate(w: WaiverTemplateRow, signatureCount?: number) {
  return {
    id: w.id,
    name: w.name,
    templateHtml: w.template_html,
    requiresMinorSignature: w.requires_minor_signature,
    isActive: w.is_active,
    createdAt: w.created_at,
    ...(signatureCount !== undefined ? { signatureCount } : {}),
  };
}

/**
 * GET /templates — staff (order:read). Every waiver template version for the tenant,
 * newest first, each with how many signatures reference it (so a version with signed
 * history is visibly un-deletable). The active version is flagged.
 */
waivers.get('/templates', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:read');

  const templates = await c.var.db.waiver.findMany({
    orderBy: { created_at: 'desc' },
    include: { _count: { select: { signatures: true } } },
  });

  return c.json({
    templates: templates.map((t) => serializeTemplate(t, t._count.signatures)),
  });
});

/**
 * POST /templates — staff (operator:manage). Publishes a NEW waiver version (never
 * mutates an existing one — see the file header on audit integrity). When `activate`
 * (default true), the prior active version is deactivated in the same transaction so
 * exactly one version is ever active.
 */
waivers.post('/templates', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');

  const parsed = createTemplateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  const { name, templateHtml, requiresMinorSignature, activate } = parsed.data;

  const created = await c.var.db.$transaction(async (tx) => {
    if (activate) {
      await tx.waiver.updateMany({ where: { is_active: true }, data: { is_active: false } });
    }
    return tx.waiver.create({
      data: {
        id: createId(),
        operator_id: c.var.operatorId,
        name,
        template_html: templateHtml,
        requires_minor_signature: requiresMinorSignature,
        is_active: activate,
      },
    });
  });

  return c.json({ template: serializeTemplate(created) }, 201);
});

/**
 * POST /templates/:id/activate — staff (operator:manage). Makes a specific version the
 * active one (deactivating every other version) in a single transaction. Signing always
 * uses the active version; switching never alters past signatures.
 */
waivers.post('/templates/:id/activate', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');

  const id = c.req.param('id');
  // Confirm the target exists within this tenant (RLS scopes the read) before flipping.
  const target = await c.var.db.waiver.findFirst({ where: { id }, select: { id: true } });
  if (!target) {
    return c.json({ error: 'Waiver template not found' }, 404);
  }

  const activated = await c.var.db.$transaction(async (tx) => {
    await tx.waiver.updateMany({ where: { is_active: true, NOT: { id } }, data: { is_active: false } });
    return tx.waiver.update({ where: { id }, data: { is_active: true } });
  });

  return c.json({ template: serializeTemplate(activated) });
});
