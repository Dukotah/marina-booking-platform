'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { withTenant, type Prisma } from '@marina/database';
import { AuthorizationError } from '@marina/auth';
import { getTenantDb, requirePermission } from '../../../lib/session';

/**
 * Server actions for the operator waiver editor (admin talks to the DB directly
 * per D-007, same as the resources settings slice).
 *
 * THE LEGAL INVARIANT (mirrors apps/api/src/services/waivers-service.ts, which
 * owns the same rule for the API surface): any change to the text a customer is
 * shown — the waiver's name, its intro, or any clause (content, flags that alter
 * what must be acknowledged, order, existence) — bumps `Waiver.version` in the
 * SAME transaction as the edit. Existing WaiverSignature rows are NEVER touched:
 * their snapshot_html + waiver_version are the immutable record of what was
 * actually agreed to, and a later edit must not be able to rewrite that history.
 */

export interface WaiverActionResult {
  ok: boolean;
  errors?: Record<string, string>;
  message?: string;
  /** The waiver version after the mutation (bumped when text changed). */
  version?: number;
  /** Id of a newly created entity (waiver or clause). */
  id?: string;
}

function zodErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    if (!(path in out)) out[path] = issue.message;
  }
  return out;
}

function denied(): WaiverActionResult {
  return { ok: false, message: 'You do not have permission to manage waivers.' };
}

const waiverSchema = z.object({
  name: z.string().trim().min(1, 'Waiver name is required').max(200),
  /** Plain-ish HTML preamble; empty clears it. */
  introHtml: z.string().max(50_000).default(''),
  requiresMinorSignature: z.coerce.boolean().default(true),
});

const clauseSchema = z.object({
  title: z.string().trim().min(1, 'Clause title is required').max(200),
  bodyHtml: z.string().trim().min(1, 'Clause text is required').max(50_000),
  requiresInitials: z.coerce.boolean().default(true),
  isRequired: z.coerce.boolean().default(true),
});

export type WaiverInput = z.infer<typeof waiverSchema>;
export type ClauseInput = z.infer<typeof clauseSchema>;

/** Best-effort waiver.edit audit row — a failure logs, never blocks the edit. */
async function auditWaiverEdit(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  args: { operatorId: string; actor: string; actorRole: string; waiverId: string; version: number; op: string },
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        operator_id: args.operatorId,
        actor: args.actor,
        actor_role: args.actorRole,
        action: 'waiver.edit',
        entity_type: 'Waiver',
        entity_id: args.waiverId,
        after: { version: args.version, op: args.op } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[waivers] audit write failed', err);
  }
}

/** Typed, user-facing failure raised inside a mutation. */
class ActionFailure extends Error {}

/** Shared wrapper: permission gate → mutation → audit → revalidate. */
async function run(
  op: string,
  fn: (operatorId: string) => Promise<{ waiverId: string; version: number; id?: string }>,
): Promise<WaiverActionResult> {
  try {
    const { operatorId, auth } = await requirePermission('operator:manage');
    const result = await fn(operatorId);
    const db = await getTenantDb();
    await auditWaiverEdit(db, {
      operatorId,
      actor: auth.userId,
      actorRole: auth.role,
      waiverId: result.waiverId,
      version: result.version,
      op,
    });
    revalidatePath('/settings/waivers');
    return { ok: true, version: result.version, id: result.id };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    if (err instanceof ActionFailure) return { ok: false, message: err.message };
    throw err;
  }
}

/**
 * Edit the waiver's name / intro / minor-signature policy. Version bumps only
 * when customer-visible text (name or intro) actually changed — toggling the
 * minor policy doesn't rewrite what a past signer read.
 */
export async function updateWaiverAction(
  waiverId: string,
  input: WaiverInput,
): Promise<WaiverActionResult> {
  const parsed = waiverSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
  const v = parsed.data;

  return run('update_waiver', (operatorId) =>
    withTenant(operatorId, async (tx) => {
      const waiver = await tx.waiver.findFirst({
        where: { id: waiverId },
        select: { id: true, name: true, intro_html: true },
      });
      if (!waiver) throw new ActionFailure('Waiver not found.');

      const textChanged =
        v.name !== waiver.name || (v.introHtml.trim() || null) !== waiver.intro_html;

      const updated = await tx.waiver.update({
        where: { id: waiver.id },
        data: {
          name: v.name,
          intro_html: v.introHtml.trim() || null,
          requires_minor_signature: v.requiresMinorSignature,
          ...(textChanged ? { version: { increment: 1 } } : {}),
        },
        select: { id: true, version: true },
      });
      return { waiverId: updated.id, version: updated.version };
    }),
  );
}

/** Add a clause at the end of the waiver. Always a text change → version bump. */
export async function addClauseAction(
  waiverId: string,
  input: ClauseInput,
): Promise<WaiverActionResult> {
  const parsed = clauseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
  const v = parsed.data;

  return run('create_clause', (operatorId) =>
    withTenant(operatorId, async (tx) => {
      const waiver = await tx.waiver.findFirst({ where: { id: waiverId }, select: { id: true } });
      if (!waiver) throw new ActionFailure('Waiver not found.');

      const last = await tx.waiverClause.findFirst({
        where: { waiver_id: waiver.id },
        orderBy: { sort_order: 'desc' },
        select: { sort_order: true },
      });
      const clause = await tx.waiverClause.create({
        data: {
          operator_id: operatorId,
          waiver_id: waiver.id,
          sort_order: (last?.sort_order ?? -1) + 1,
          title: v.title,
          body_html: v.bodyHtml,
          requires_initials: v.requiresInitials,
          is_required: v.isRequired,
        },
        select: { id: true },
      });
      const bumped = await tx.waiver.update({
        where: { id: waiver.id },
        data: { version: { increment: 1 } },
        select: { id: true, version: true },
      });
      return { waiverId: bumped.id, version: bumped.version, id: clause.id };
    }),
  );
}

/** Edit a clause. Bumps the version only when something actually changed. */
export async function updateClauseAction(
  clauseId: string,
  input: ClauseInput,
): Promise<WaiverActionResult> {
  const parsed = clauseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
  const v = parsed.data;

  return run('update_clause', (operatorId) =>
    withTenant(operatorId, async (tx) => {
      const clause = await tx.waiverClause.findFirst({
        where: { id: clauseId },
        select: {
          id: true,
          waiver_id: true,
          title: true,
          body_html: true,
          requires_initials: true,
          is_required: true,
        },
      });
      if (!clause) throw new ActionFailure('Clause not found.');

      const changed =
        v.title !== clause.title ||
        v.bodyHtml !== clause.body_html ||
        v.requiresInitials !== clause.requires_initials ||
        v.isRequired !== clause.is_required;

      if (changed) {
        await tx.waiverClause.update({
          where: { id: clause.id },
          data: {
            title: v.title,
            body_html: v.bodyHtml,
            requires_initials: v.requiresInitials,
            is_required: v.isRequired,
          },
        });
        const bumped = await tx.waiver.update({
          where: { id: clause.waiver_id },
          data: { version: { increment: 1 } },
          select: { id: true, version: true },
        });
        return { waiverId: bumped.id, version: bumped.version };
      }
      const w = await tx.waiver.findFirstOrThrow({
        where: { id: clause.waiver_id },
        select: { id: true, version: true },
      });
      return { waiverId: w.id, version: w.version };
    }),
  );
}

/** Delete a clause. Removing presented text is a text change → version bump. */
export async function deleteClauseAction(clauseId: string): Promise<WaiverActionResult> {
  return run('delete_clause', (operatorId) =>
    withTenant(operatorId, async (tx) => {
      const clause = await tx.waiverClause.findFirst({
        where: { id: clauseId },
        select: { id: true, waiver_id: true },
      });
      if (!clause) throw new ActionFailure('Clause not found.');

      await tx.waiverClause.delete({ where: { id: clause.id } });
      const bumped = await tx.waiver.update({
        where: { id: clause.waiver_id },
        data: { version: { increment: 1 } },
        select: { id: true, version: true },
      });
      return { waiverId: bumped.id, version: bumped.version };
    }),
  );
}

/**
 * Move a clause one step up/down. Sort orders are normalized to index positions
 * so legacy gaps can't make a swap ambiguous. Order changes what a signer reads
 * → version bump; moving past an end is a no-op.
 */
export async function moveClauseAction(
  clauseId: string,
  direction: 'up' | 'down',
): Promise<WaiverActionResult> {
  if (direction !== 'up' && direction !== 'down') {
    return { ok: false, message: 'Invalid direction.' };
  }
  return run('move_clause', (operatorId) =>
    withTenant(operatorId, async (tx) => {
      const clause = await tx.waiverClause.findFirst({
        where: { id: clauseId },
        select: { id: true, waiver_id: true },
      });
      if (!clause) throw new ActionFailure('Clause not found.');

      const siblings = await tx.waiverClause.findMany({
        where: { waiver_id: clause.waiver_id },
        orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
        select: { id: true },
      });
      const index = siblings.findIndex((s) => s.id === clause.id);
      const target = direction === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= siblings.length) {
        const w = await tx.waiver.findFirstOrThrow({
          where: { id: clause.waiver_id },
          select: { id: true, version: true },
        });
        return { waiverId: w.id, version: w.version };
      }

      const order = siblings.map((s) => s.id);
      [order[index], order[target]] = [order[target]!, order[index]!];
      for (let i = 0; i < order.length; i++) {
        await tx.waiverClause.update({ where: { id: order[i]! }, data: { sort_order: i } });
      }
      const bumped = await tx.waiver.update({
        where: { id: clause.waiver_id },
        data: { version: { increment: 1 } },
        select: { id: true, version: true },
      });
      return { waiverId: bumped.id, version: bumped.version };
    }),
  );
}

/** First-run: create an active waiver so the editor has something to edit. */
export async function createWaiverAction(): Promise<WaiverActionResult> {
  return run('create_waiver', (operatorId) =>
    withTenant(operatorId, async (tx) => {
      const existing = await tx.waiver.findFirst({
        where: { is_active: true },
        select: { id: true, version: true },
      });
      // Idempotent: a double-submit must not leave two active waivers.
      if (existing) return { waiverId: existing.id, version: existing.version, id: existing.id };

      const created = await tx.waiver.create({
        data: {
          operator_id: operatorId,
          name: 'Liability Waiver & Release',
          template_html: '',
          intro_html:
            '<p>Please read this document carefully before signing. It affects your legal rights.</p>',
          version: 1,
          requires_minor_signature: true,
          is_active: true,
        },
        select: { id: true, version: true },
      });
      return { waiverId: created.id, version: created.version, id: created.id };
    }),
  );
}
