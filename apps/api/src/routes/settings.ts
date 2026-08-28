import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import { getClientIp } from '../middleware/rate-limit.js';
import { AUDIT_ACTIONS, recordAudit, staffActor } from '../services/audit.js';

/**
 * Config / settings parity API (Singenuity §4). Mounted under `/api/settings`. Each
 * sub-resource is a small CRUD surface behind `operator:manage`, tenant-scoped via
 * the RLS client (`c.var.db`) — a foreign id simply isn't found. Writes still set an
 * explicit `operator_id` (required column) which the RLS GUC guarantees matches the
 * tenant.
 *
 * Covers: customer questions, affiliates, message templates, heard-about options,
 * blackout dates, and GL accounts.
 */
export const settings = new Hono<Env>();

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

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

/** Parse+validate a JSON body against a schema, returning null on parse failure. */
async function readBody(c: Context<Env>): Promise<unknown> {
  return c.req.json().catch(() => null);
}

// --- Auditing -------------------------------------------------------------

/**
 * Columns every row here carries that nobody audits: the id and operator are
 * already on the audit row itself, and `updated_at` would flag every edit as a
 * change to a field the operator never touched.
 */
const AUDIT_OMIT_COLUMNS = new Set(['id', 'operator_id', 'created_at', 'updated_at']);

function auditableRow<T extends object>(row: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !AUDIT_OMIT_COLUMNS.has(key)),
  );
}

/**
 * Record one configuration write.
 *
 * Every sub-resource in this file is operator configuration, so they all share
 * `settings.update`; `entityType` is what tells a reader whether a blackout date
 * or a GL account moved. Omitting `before` marks a creation and omitting `after`
 * a deletion — that is how services/audit.ts reads a one-sided diff.
 */
async function auditSettingsChange(
  c: Context<Env>,
  entityType: string,
  entityId: string,
  change: { before?: object | null; after?: object | null; context?: Record<string, unknown> },
): Promise<void> {
  await recordAudit({
    operatorId: c.var.operatorId,
    actor: staffActor(c.var.auth, getClientIp((h) => c.req.header(h))),
    action: AUDIT_ACTIONS.SETTINGS_UPDATE,
    entityType,
    entityId,
    before: change.before ? auditableRow(change.before) : undefined,
    after: change.after ? auditableRow(change.after) : undefined,
    context: change.context,
  });
}

// ===========================================================================
// Customer Questions
// ===========================================================================

const QUESTION_TYPES = ['TEXT', 'TEXTAREA', 'SELECT', 'CHECKBOX', 'NUMBER'] as const;

const questionCreateSchema = z
  .object({
    label: z.string().trim().min(1, 'label is required').max(200),
    type: z.enum(QUESTION_TYPES).default('TEXT'),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
    applies_to: z.string().min(1).nullable().optional(),
    is_active: z.boolean().default(true),
    sort_index: z.number().int().min(0).max(9999).default(0),
  })
  .strict();

const questionUpdateSchema = questionCreateSchema.partial().strict();

settings.get('/questions', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const questions = await c.var.db.customerQuestion.findMany({
    orderBy: [{ sort_index: 'asc' }, { created_at: 'asc' }],
  });
  return c.json({ questions });
});

settings.post('/questions', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const parsed = questionCreateSchema.safeParse(await readBody(c));
  if (!parsed.success) return badRequest(c, parsed.error);
  const d = parsed.data;
  const question = await c.var.db.customerQuestion.create({
    data: {
      operator_id: c.var.operatorId,
      label: d.label,
      type: d.type,
      required: d.required,
      options: d.options,
      applies_to: d.applies_to ?? null,
      is_active: d.is_active,
      sort_index: d.sort_index,
    },
  });
  await auditSettingsChange(c, 'CustomerQuestion', question.id, { after: question });
  return c.json({ question }, 201);
});

settings.patch('/questions/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const id = c.req.param('id');
  const parsed = questionUpdateSchema.safeParse(await readBody(c));
  if (!parsed.success) return badRequest(c, parsed.error);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);
  const existing = await c.var.db.customerQuestion.findFirst({ where: { id } });
  if (!existing) return c.json({ error: 'Question not found' }, 404);
  const d = parsed.data;
  const question = await c.var.db.customerQuestion.update({
    where: { id },
    data: {
      ...(d.label !== undefined ? { label: d.label } : {}),
      ...(d.type !== undefined ? { type: d.type } : {}),
      ...(d.required !== undefined ? { required: d.required } : {}),
      ...(d.options !== undefined ? { options: d.options } : {}),
      ...(d.applies_to !== undefined ? { applies_to: d.applies_to } : {}),
      ...(d.is_active !== undefined ? { is_active: d.is_active } : {}),
      ...(d.sort_index !== undefined ? { sort_index: d.sort_index } : {}),
    },
  });
  await auditSettingsChange(c, 'CustomerQuestion', question.id, {
    before: existing,
    after: question,
  });
  return c.json({ question });
});

settings.delete('/questions/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const id = c.req.param('id');
  const existing = await c.var.db.customerQuestion.findFirst({ where: { id } });
  if (!existing) return c.json({ error: 'Question not found' }, 404);
  await c.var.db.customerQuestion.delete({ where: { id } });
  await auditSettingsChange(c, 'CustomerQuestion', id, { before: existing });
  return c.json({ ok: true });
});

// ===========================================================================
// Affiliates
// ===========================================================================

const affiliateCreateSchema = z
  .object({
    name: z.string().trim().min(1, 'name is required').max(160),
    code: z.string().trim().min(1, 'code is required').max(64),
    email: z.string().trim().email().max(254).nullable().optional(),
    commission_percent: z.number().int().min(0).max(100).nullable().optional(),
    is_active: z.boolean().default(true),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const affiliateUpdateSchema = affiliateCreateSchema.partial().strict();

settings.get('/affiliates', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const affiliates = await c.var.db.affiliate.findMany({ orderBy: { name: 'asc' } });
  return c.json({ affiliates });
});

settings.post('/affiliates', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const parsed = affiliateCreateSchema.safeParse(await readBody(c));
  if (!parsed.success) return badRequest(c, parsed.error);
  const d = parsed.data;
  try {
    const affiliate = await c.var.db.affiliate.create({
      data: {
        operator_id: c.var.operatorId,
        name: d.name,
        code: d.code,
        email: d.email ?? null,
        commission_percent: d.commission_percent ?? null,
        is_active: d.is_active,
        notes: d.notes ?? null,
      },
    });
    await auditSettingsChange(c, 'Affiliate', affiliate.id, { after: affiliate });
    return c.json({ affiliate }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'That affiliate code is already in use' }, 409);
    throw err;
  }
});

settings.patch('/affiliates/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const id = c.req.param('id');
  const parsed = affiliateUpdateSchema.safeParse(await readBody(c));
  if (!parsed.success) return badRequest(c, parsed.error);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);
  const existing = await c.var.db.affiliate.findFirst({ where: { id } });
  if (!existing) return c.json({ error: 'Affiliate not found' }, 404);
  const d = parsed.data;
  try {
    const affiliate = await c.var.db.affiliate.update({
      where: { id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.code !== undefined ? { code: d.code } : {}),
        ...(d.email !== undefined ? { email: d.email } : {}),
        ...(d.commission_percent !== undefined ? { commission_percent: d.commission_percent } : {}),
        ...(d.is_active !== undefined ? { is_active: d.is_active } : {}),
        ...(d.notes !== undefined ? { notes: d.notes } : {}),
      },
    });
    await auditSettingsChange(c, 'Affiliate', affiliate.id, {
      before: existing,
      after: affiliate,
    });
    return c.json({ affiliate });
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'That affiliate code is already in use' }, 409);
    throw err;
  }
});

// ===========================================================================
// Message Templates (editable confirmation/reminder/refund copy)
// ===========================================================================

const TEMPLATE_KINDS = ['BOOKING_CONFIRMATION', 'BOOKING_REMINDER', 'REFUND_RECEIPT'] as const;

const templateUpsertSchema = z
  .object({
    enabled: z.boolean().default(true),
    subject_override: z.string().trim().max(300).nullable().optional(),
    body_override: z.string().trim().max(20000).nullable().optional(),
  })
  .strict();

settings.get('/templates', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const rows = await c.var.db.messageTemplate.findMany();
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  // Return an entry for every kind so the UI can render a form even when unedited.
  const templates = TEMPLATE_KINDS.map((kind) => {
    const row = byKind.get(kind);
    return {
      kind,
      enabled: row?.enabled ?? true,
      subject_override: row?.subject_override ?? null,
      body_override: row?.body_override ?? null,
    };
  });
  return c.json({ templates });
});

settings.put('/templates/:kind', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const kindParam = c.req.param('kind').toUpperCase();
  if (!(TEMPLATE_KINDS as readonly string[]).includes(kindParam)) {
    return c.json({ error: 'Unknown template kind' }, 400);
  }
  const kind = kindParam as (typeof TEMPLATE_KINDS)[number];
  const parsed = templateUpsertSchema.safeParse(await readBody(c));
  if (!parsed.success) return badRequest(c, parsed.error);
  const d = parsed.data;
  const operatorId = c.var.operatorId;
  // An upsert hides whether this was the first edit or the fortieth; read the row
  // it is about to replace so the audit diff can say which, and what it replaced.
  const existing = await c.var.db.messageTemplate.findUnique({
    where: { operator_id_kind: { operator_id: operatorId, kind } },
  });
  const template = await c.var.db.messageTemplate.upsert({
    where: { operator_id_kind: { operator_id: operatorId, kind } },
    create: {
      operator_id: operatorId,
      kind,
      enabled: d.enabled,
      subject_override: d.subject_override ?? null,
      body_override: d.body_override ?? null,
    },
    update: {
      enabled: d.enabled,
      subject_override: d.subject_override ?? null,
      body_override: d.body_override ?? null,
    },
  });
  await auditSettingsChange(c, 'MessageTemplate', template.id, {
    before: existing,
    after: template,
    context: { kind },
  });
  return c.json({ template });
});

// ===========================================================================
// Heard-About options
// ===========================================================================

const heardAboutCreateSchema = z
  .object({
    label: z.string().trim().min(1, 'label is required').max(120),
    is_active: z.boolean().default(true),
    sort_index: z.number().int().min(0).max(9999).default(0),
  })
  .strict();

const heardAboutUpdateSchema = heardAboutCreateSchema.partial().strict();

settings.get('/heard-about', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const options = await c.var.db.heardAboutOption.findMany({
    orderBy: [{ sort_index: 'asc' }, { label: 'asc' }],
  });
  return c.json({ options });
});

settings.post('/heard-about', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const parsed = heardAboutCreateSchema.safeParse(await readBody(c));
  if (!parsed.success) return badRequest(c, parsed.error);
  const d = parsed.data;
  const option = await c.var.db.heardAboutOption.create({
    data: { operator_id: c.var.operatorId, label: d.label, is_active: d.is_active, sort_index: d.sort_index },
  });
  await auditSettingsChange(c, 'HeardAboutOption', option.id, { after: option });
  return c.json({ option }, 201);
});

settings.patch('/heard-about/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const id = c.req.param('id');
  const parsed = heardAboutUpdateSchema.safeParse(await readBody(c));
  if (!parsed.success) return badRequest(c, parsed.error);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);
  const existing = await c.var.db.heardAboutOption.findFirst({ where: { id } });
  if (!existing) return c.json({ error: 'Option not found' }, 404);
  const d = parsed.data;
  const option = await c.var.db.heardAboutOption.update({
    where: { id },
    data: {
      ...(d.label !== undefined ? { label: d.label } : {}),
      ...(d.is_active !== undefined ? { is_active: d.is_active } : {}),
      ...(d.sort_index !== undefined ? { sort_index: d.sort_index } : {}),
    },
  });
  await auditSettingsChange(c, 'HeardAboutOption', option.id, {
    before: existing,
    after: option,
  });
  return c.json({ option });
});

settings.delete('/heard-about/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const id = c.req.param('id');
  const existing = await c.var.db.heardAboutOption.findFirst({ where: { id } });
  if (!existing) return c.json({ error: 'Option not found' }, 404);
  await c.var.db.heardAboutOption.delete({ where: { id } });
  await auditSettingsChange(c, 'HeardAboutOption', id, { before: existing });
  return c.json({ ok: true });
});

// ===========================================================================
// Blackout dates
// ===========================================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a YYYY-MM-DD string into a UTC-midnight Date (the storage convention). */
function parseDayToUtcMidnight(value: string): Date | null {
  if (!DATE_RE.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return probe;
}

const blackoutCreateSchema = z
  .object({
    date: z.string().regex(DATE_RE, 'date must be YYYY-MM-DD'),
    location_id: z.string().min(1).nullable().optional(),
    reason: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

function serializeBlackout(b: { id: string; date: Date; location_id: string | null; reason: string | null; created_at: Date }) {
  return {
    id: b.id,
    date: b.date.toISOString().slice(0, 10),
    location_id: b.location_id,
    reason: b.reason,
    created_at: b.created_at,
  };
}

settings.get('/blackouts', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const rows = await c.var.db.blackoutDate.findMany({ orderBy: { date: 'asc' } });
  return c.json({ blackouts: rows.map(serializeBlackout) });
});

settings.post('/blackouts', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const parsed = blackoutCreateSchema.safeParse(await readBody(c));
  if (!parsed.success) return badRequest(c, parsed.error);
  const d = parsed.data;
  const date = parseDayToUtcMidnight(d.date);
  if (!date) return c.json({ error: 'date is not a valid calendar date' }, 400);
  // If a location scope was supplied, verify it belongs to this tenant (RLS-scoped).
  if (d.location_id) {
    const loc = await c.var.db.location.findFirst({ where: { id: d.location_id } });
    if (!loc) return c.json({ error: 'Location not found' }, 404);
  }
  const blackout = await c.var.db.blackoutDate.create({
    data: {
      operator_id: c.var.operatorId,
      date,
      location_id: d.location_id ?? null,
      reason: d.reason ?? null,
    },
  });
  await auditSettingsChange(c, 'BlackoutDate', blackout.id, { after: blackout });
  return c.json({ blackout: serializeBlackout(blackout) }, 201);
});

settings.delete('/blackouts/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const id = c.req.param('id');
  const existing = await c.var.db.blackoutDate.findFirst({ where: { id } });
  if (!existing) return c.json({ error: 'Blackout not found' }, 404);
  await c.var.db.blackoutDate.delete({ where: { id } });
  await auditSettingsChange(c, 'BlackoutDate', id, { before: existing });
  return c.json({ ok: true });
});

// ===========================================================================
// GL accounts
// ===========================================================================

const glCreateSchema = z
  .object({
    code: z.string().trim().min(1, 'code is required').max(32),
    name: z.string().trim().min(1, 'name is required').max(160),
    category: z.string().trim().max(64).nullable().optional(),
    is_active: z.boolean().default(true),
  })
  .strict();

const glUpdateSchema = glCreateSchema.partial().strict();

settings.get('/gl-accounts', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const accounts = await c.var.db.gLAccount.findMany({ orderBy: { code: 'asc' } });
  return c.json({ accounts });
});

settings.post('/gl-accounts', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const parsed = glCreateSchema.safeParse(await readBody(c));
  if (!parsed.success) return badRequest(c, parsed.error);
  const d = parsed.data;
  try {
    const account = await c.var.db.gLAccount.create({
      data: {
        operator_id: c.var.operatorId,
        code: d.code,
        name: d.name,
        category: d.category ?? null,
        is_active: d.is_active,
      },
    });
    await auditSettingsChange(c, 'GLAccount', account.id, { after: account });
    return c.json({ account }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'That GL code is already in use' }, 409);
    throw err;
  }
});

settings.patch('/gl-accounts/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const id = c.req.param('id');
  const parsed = glUpdateSchema.safeParse(await readBody(c));
  if (!parsed.success) return badRequest(c, parsed.error);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);
  const existing = await c.var.db.gLAccount.findFirst({ where: { id } });
  if (!existing) return c.json({ error: 'GL account not found' }, 404);
  const d = parsed.data;
  try {
    const account = await c.var.db.gLAccount.update({
      where: { id },
      data: {
        ...(d.code !== undefined ? { code: d.code } : {}),
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.category !== undefined ? { category: d.category } : {}),
        ...(d.is_active !== undefined ? { is_active: d.is_active } : {}),
      },
    });
    await auditSettingsChange(c, 'GLAccount', account.id, {
      before: existing,
      after: account,
    });
    return c.json({ account });
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'That GL code is already in use' }, 409);
    throw err;
  }
});
