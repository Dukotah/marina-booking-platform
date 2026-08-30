/**
 * Dynamic pricing rules API.
 *
 *   POST   /quote            public — price one slot and return a SIGNED quote
 *   GET    /                 staff  — every rule for this tenant (activity:read)
 *   POST   /preview          staff  — what would this date/activity cost? (activity:read)
 *   POST   /                 staff  — create a rule (operator:manage)
 *   PATCH  /:id              staff  — edit a rule (operator:manage)
 *   POST   /:id/toggle       staff  — enable / disable (operator:manage)
 *   POST   /reorder          staff  — renumber priorities (operator:manage)
 *   DELETE /:id              staff  — delete (operator:manage)
 *
 * All data access is tenant-scoped by RLS through `c.var.db`; the pricing maths
 * and every DB read live in services/pricing-rules.ts. Mounted by the
 * orchestrator at /api/pricing-rules.
 *
 * `/preview` accepts DRAFT rules that do not exist in the database yet — that is
 * deliberate, and it is what makes the admin's preview honest: it runs the same
 * engine call the booking path runs, on the rule the operator is currently
 * typing, against the rate's real list price.
 *
 * `/quote` is public because the customer app needs it: it returns the price AND
 * a signed token that pins it. Checkout hands the token back and the server
 * honours the quoted price even if a rule changed in between (see
 * `reconcileSlotPrice`), which is how "the price you were shown is the price you
 * pay" stops being a promise and becomes a mechanism.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import { PRICING_RULE_KINDS, type DynamicPricingRule } from '@marina/core';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import { getClientIp } from '../middleware/rate-limit.js';
import { AUDIT_ACTIONS, recordAudit, staffActor } from '../services/audit.js';
import {
  PERSISTABLE_RULE_KINDS,
  PricingRuleError,
  createPricingRule,
  deletePricingRule,
  issuePriceQuote,
  listPricingRules,
  previewPrice,
  reorderPricingRules,
  setPricingRuleActive,
  updatePricingRule,
  type PricingRuleInput,
} from '../services/pricing-rules.js';

export const pricingRules = new Hono<Env>();

// --- Helpers --------------------------------------------------------------

function badRequest(c: Context<Env>, error: z.ZodError) {
  return c.json(
    {
      error: 'Validation failed',
      issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    },
    400,
  );
}

/** Map a service error onto its HTTP status; anything else is a real 500. */
function handle(c: Context<Env>, err: unknown): Response {
  if (err instanceof PricingRuleError) {
    return c.json({ error: err.message, code: err.code }, err.status as 400);
  }
  throw err;
}

const kindSchema = z.enum(
  PRICING_RULE_KINDS as unknown as [string, ...string[]],
) as z.ZodType<PricingRuleInput['kind']>;

/** An ISO date-time string. Kept as a string in the wire format so a client's
 *  timezone handling is explicit rather than accidental. */
const dateSchema = z.coerce.date();

const ruleBodySchema = z.object({
  name: z.string().trim().min(1, 'Give the rule a name').max(120),
  kind: kindSchema,
  adjustmentType: z.enum(['PERCENT', 'FLAT']),
  adjustmentValue: z.number().int('Adjustments are whole percent or whole cents'),
  priority: z.number().int().min(0).max(9_999).default(0),
  isActive: z.boolean().default(true),
  activityId: z.string().min(1).nullable().default(null),
  rateId: z.string().min(1).nullable().default(null),
  startsOn: dateSchema.nullable().default(null),
  endsOn: dateSchema.nullable().default(null),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  startMinute: z.number().int().min(0).max(1439).nullable().default(null),
  endMinute: z.number().int().min(0).max(1439).nullable().default(null),
  minLeadMinutes: z.number().int().min(0).max(525_600).nullable().default(null),
  maxLeadMinutes: z.number().int().min(0).max(525_600).nullable().default(null),
  demandThreshold: z.number().min(0).max(1).nullable().default(null),
});

/** A draft rule for the preview: the same shape, plus a client-side id. */
const draftRuleSchema = ruleBodySchema.extend({ id: z.string().min(1).default('draft') });

const previewSchema = z.object({
  activityId: z.string().min(1),
  rateId: z.string().min(1),
  slotStart: dateSchema,
  /** When the hypothetical booking is made — drives lead-time rules. */
  bookingAt: dateSchema.optional(),
  capacityTotal: z.number().int().min(0).optional(),
  capacityBooked: z.number().int().min(0).optional(),
  draftRules: z.array(draftRuleSchema).max(50).optional(),
});

const quoteSchema = z.object({
  timeslotId: z.string().min(1),
  rateId: z.string().min(1),
  quantity: z.number().int().min(1).max(500).default(1),
});

const reorderSchema = z.object({ orderedIds: z.array(z.string().min(1)).min(1).max(500) });

const toggleSchema = z.object({ isActive: z.boolean() });

/** Zod output -> the service's input shape. */
function toRuleInput(v: z.infer<typeof ruleBodySchema>): PricingRuleInput {
  return {
    name: v.name,
    kind: v.kind,
    adjustmentType: v.adjustmentType,
    adjustmentValue: v.adjustmentValue,
    priority: v.priority,
    isActive: v.isActive,
    activityId: v.activityId,
    rateId: v.rateId,
    startsOn: v.startsOn,
    endsOn: v.endsOn,
    weekdays: v.weekdays,
    startMinute: v.startMinute,
    endMinute: v.endMinute,
    minLeadMinutes: v.minLeadMinutes,
    maxLeadMinutes: v.maxLeadMinutes,
    demandThreshold: v.demandThreshold,
  };
}

function toDraftRule(v: z.infer<typeof draftRuleSchema>): DynamicPricingRule {
  return { id: v.id, ...toRuleInput(v) } as DynamicPricingRule;
}

// --- Public: quote a slot -------------------------------------------------

/**
 * POST /api/pricing-rules/quote — PUBLIC.
 *
 * Returns the effective unit price for a slot plus a signed token. The token is
 * what checkout presents; without it the server re-prices and the guest has to
 * see the new number before anything is charged.
 */
pricingRules.post('/quote', async (c) => {
  const parsed = quoteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return badRequest(c, parsed.error);
  const { timeslotId, rateId, quantity } = parsed.data;

  const timeslot = await c.var.db.timeslot.findUnique({
    where: { id: timeslotId },
    select: {
      id: true,
      activity_id: true,
      datetime: true,
      capacity_total: true,
      capacity_booked: true,
    },
  });
  if (!timeslot) return c.json({ error: 'Timeslot not found', code: 'SLOT_NOT_FOUND' }, 404);

  const rate = await c.var.db.rate.findUnique({
    where: { id: rateId },
    select: { price_cents: true, activity_id: true, is_active: true },
  });
  if (!rate || !rate.is_active) return c.json({ error: 'Rate not found', code: 'RATE_NOT_FOUND' }, 404);
  if (rate.activity_id !== timeslot.activity_id) {
    return c.json({ error: 'That rate is not sold for this slot', code: 'SCOPE_MISMATCH' }, 400);
  }

  try {
    const quote = await issuePriceQuote(c.var.db, c.var.operatorId, {
      activityId: timeslot.activity_id,
      rateId,
      basePriceCents: rate.price_cents,
      slotStart: timeslot.datetime,
      capacityTotal: timeslot.capacity_total,
      capacityBooked: timeslot.capacity_booked,
      timeslotId: timeslot.id,
      quantity,
    });

    return c.json({
      quote: {
        token: quote.token,
        expiresAt: quote.expiresAt.toISOString(),
        quantity,
        unitPriceCents: quote.unitPriceCents,
        basePriceCents: quote.basePriceCents,
        lineTotalCents: quote.unitPriceCents * quantity,
        // The guest sees WHY the price moved. Suppressed rules are operator-only
        // detail and are deliberately not exposed on the public endpoint.
        adjustments: quote.result.applied.map((a) => ({
          name: a.name,
          kind: a.kind,
          deltaCents: a.deltaCents,
        })),
      },
    });
  } catch (err) {
    return handle(c, err);
  }
});

// --- Staff: read ----------------------------------------------------------

/** GET /api/pricing-rules — every rule, plus what this schema can persist. */
pricingRules.get('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:read');
  const rules = await listPricingRules(c.var.db);
  return c.json({
    rules,
    // The admin uses this to explain why a kind cannot be saved yet rather than
    // offering a control that would fail on submit.
    persistableKinds: [...PERSISTABLE_RULE_KINDS],
  });
});

/**
 * POST /api/pricing-rules/preview — what would this cost?
 *
 * With `draftRules` it prices the operator's unsaved edit; without them it prices
 * what is stored. Either way it is the same engine call the booking path makes.
 */
pricingRules.post('/preview', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'activity:read');
  const parsed = previewSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return badRequest(c, parsed.error);
  const v = parsed.data;

  try {
    const result = await previewPrice(c.var.db, c.var.operatorId, {
      activityId: v.activityId,
      rateId: v.rateId,
      slotStart: v.slotStart,
      now: v.bookingAt,
      capacityTotal: v.capacityTotal ?? null,
      capacityBooked: v.capacityBooked ?? null,
      draftRules: v.draftRules?.map(toDraftRule),
    });
    return c.json({ preview: { ...result, slotStart: result.slotStart.toISOString() } });
  } catch (err) {
    return handle(c, err);
  }
});

// --- Staff: write ---------------------------------------------------------

/** POST /api/pricing-rules — create a rule. */
pricingRules.post('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const parsed = ruleBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return badRequest(c, parsed.error);

  try {
    const rule = await createPricingRule(c.var.db, c.var.operatorId, toRuleInput(parsed.data));
    await recordAudit({
      operatorId: c.var.operatorId,
      actor: staffActor(c.var.auth, getClientIp((h) => c.req.header(h))),
      action: AUDIT_ACTIONS.SETTINGS_UPDATE,
      entityType: 'PricingRule',
      entityId: rule.id,
      after: rule,
      context: { route: 'POST /api/pricing-rules' },
    });
    return c.json({ rule }, 201);
  } catch (err) {
    return handle(c, err);
  }
});

/** PATCH /api/pricing-rules/:id — replace a rule's configuration. */
pricingRules.patch('/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const parsed = ruleBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return badRequest(c, parsed.error);

  const id = c.req.param('id');
  const before = await c.var.db.pricingRule.findUnique({ where: { id } });
  if (!before) return c.json({ error: 'Pricing rule not found', code: 'NOT_FOUND' }, 404);

  try {
    const rule = await updatePricingRule(c.var.db, id, toRuleInput(parsed.data));
    await recordAudit({
      operatorId: c.var.operatorId,
      actor: staffActor(c.var.auth, getClientIp((h) => c.req.header(h))),
      action: AUDIT_ACTIONS.SETTINGS_UPDATE,
      entityType: 'PricingRule',
      entityId: id,
      before,
      after: rule,
      context: { route: 'PATCH /api/pricing-rules/:id' },
    });
    return c.json({ rule });
  } catch (err) {
    return handle(c, err);
  }
});

/** POST /api/pricing-rules/:id/toggle — enable or disable without losing the config. */
pricingRules.post('/:id/toggle', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const parsed = toggleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return badRequest(c, parsed.error);

  const id = c.req.param('id');
  const before = await c.var.db.pricingRule.findUnique({ where: { id } });
  if (!before) return c.json({ error: 'Pricing rule not found', code: 'NOT_FOUND' }, 404);

  try {
    const rule = await setPricingRuleActive(c.var.db, id, parsed.data.isActive);
    await recordAudit({
      operatorId: c.var.operatorId,
      actor: staffActor(c.var.auth, getClientIp((h) => c.req.header(h))),
      action: AUDIT_ACTIONS.SETTINGS_UPDATE,
      entityType: 'PricingRule',
      entityId: id,
      before,
      after: rule,
      context: { route: 'POST /api/pricing-rules/:id/toggle' },
    });
    return c.json({ rule });
  } catch (err) {
    return handle(c, err);
  }
});

/**
 * POST /api/pricing-rules/reorder — renumber priorities from an explicit order.
 * Registered before /:id-shaped routes cannot collide (different method+path),
 * but kept adjacent to the other collection-level routes for readability.
 */
pricingRules.post('/reorder', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const parsed = reorderSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return badRequest(c, parsed.error);

  try {
    const updated = await reorderPricingRules(c.var.db, parsed.data.orderedIds);
    await recordAudit({
      operatorId: c.var.operatorId,
      actor: staffActor(c.var.auth, getClientIp((h) => c.req.header(h))),
      action: AUDIT_ACTIONS.SETTINGS_UPDATE,
      entityType: 'PricingRule',
      entityId: 'reorder',
      after: { orderedIds: parsed.data.orderedIds },
      context: { route: 'POST /api/pricing-rules/reorder', updated },
    });
    return c.json({ updated });
  } catch (err) {
    return handle(c, err);
  }
});

/** DELETE /api/pricing-rules/:id */
pricingRules.delete('/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const id = c.req.param('id');
  const before = await c.var.db.pricingRule.findUnique({ where: { id } });
  if (!before) return c.json({ error: 'Pricing rule not found', code: 'NOT_FOUND' }, 404);

  try {
    await deletePricingRule(c.var.db, id);
    await recordAudit({
      operatorId: c.var.operatorId,
      actor: staffActor(c.var.auth, getClientIp((h) => c.req.header(h))),
      action: AUDIT_ACTIONS.SETTINGS_UPDATE,
      entityType: 'PricingRule',
      entityId: id,
      before,
      context: { route: 'DELETE /api/pricing-rules/:id' },
    });
    return c.json({ ok: true });
  } catch (err) {
    return handle(c, err);
  }
});
