/**
 * Guide scheduling service (Singenuity §2 day-of ops).
 *
 * Assigns a staff member (typically role GUIDE) to run a specific Timeslot, so the
 * manifest can show "who is leading this trip" and the guide can be notified.
 *
 * Tenant safety: every write goes through the operator-scoped Prisma client
 * (`forOperator`, RLS-enforced) and the DB's tenant-composite FKs guarantee the
 * guide and timeslot both belong to the same operator. Assignment is idempotent —
 * assigning the same guide to the same slot twice returns the existing row rather
 * than erroring.
 *
 * Notifications mirror the resilience contract of notifications.ts / sms.ts: the
 * guide is emailed + texted on assignment, but a missing Resend/Twilio key is a
 * clean no-op that never throws and never blocks the assignment.
 */

import { forOperator, Prisma } from '@marina/database';
import { dateLabelFor, timeLabelFor, skipped, type NotificationResult } from './notification-data.js';
import { sendGuideAssignmentEmail } from './notifications.js';

/** Domain error for guide scheduling; carries an HTTP-ish status for routes. */
export class GuideError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, opts: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'GuideError';
    this.status = opts.status ?? 400;
    this.code = opts.code ?? 'GUIDE_ERROR';
  }
}

export interface AssignGuideInput {
  timeslotId: string;
  guideId: string;
  roleLabel?: string;
  /** Actor (StaffMember auth_user_id) recording the assignment. */
  actor?: string;
  /** When false, skip the guide notification (email/SMS). Defaults to true. */
  notify?: boolean;
}

/** A guide assignment joined with the guide + slot facts the UI needs. */
export interface GuideAssignmentView {
  id: string;
  timeslotId: string;
  guideId: string;
  guideName: string | null;
  guideEmail: string;
  roleLabel: string | null;
  createdAt: Date;
}

/**
 * Assign a guide to a timeslot. Idempotent on (timeslot, guide): a repeat call
 * returns the existing assignment (optionally updating the role label) without a
 * duplicate notification. Validates that the guide is an active staff member of the
 * operator and that the timeslot exists (RLS-scoped reads).
 */
export async function assignGuide(
  operatorId: string,
  input: AssignGuideInput,
): Promise<{ assignment: GuideAssignmentView; created: boolean; notification: NotificationResult }> {
  const db = forOperator(operatorId);

  const guide = await db.staffMember.findFirst({
    where: { id: input.guideId, is_active: true },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!guide) {
    throw new GuideError('Guide is not an active staff member of this operator', {
      status: 404,
      code: 'GUIDE_NOT_FOUND',
    });
  }

  const slot = await db.timeslot.findUnique({
    where: { id: input.timeslotId },
    select: { id: true },
  });
  if (!slot) {
    throw new GuideError('Timeslot not found', { status: 404, code: 'TIMESLOT_NOT_FOUND' });
  }

  // Idempotent upsert on the (operator, timeslot, guide) unique key.
  const existing = await db.guideAssignment.findFirst({
    where: { timeslot_id: input.timeslotId, guide_id: input.guideId },
  });

  let row;
  let created: boolean;
  if (existing) {
    created = false;
    row =
      input.roleLabel !== undefined && input.roleLabel !== existing.role_label
        ? await db.guideAssignment.update({
            where: { id: existing.id },
            data: { role_label: input.roleLabel || null },
          })
        : existing;
  } else {
    created = true;
    row = await db.guideAssignment.create({
      data: {
        operator_id: operatorId,
        timeslot_id: input.timeslotId,
        guide_id: input.guideId,
        role_label: input.roleLabel || null,
        assigned_by: input.actor ?? null,
      },
    });
  }

  // Notify only on a fresh assignment (never on an idempotent repeat).
  let notification: NotificationResult = skipped('not a new assignment');
  if (created && input.notify !== false) {
    notification = await notifyGuideAssigned(operatorId, input.timeslotId, {
      id: guide.id,
      name: guide.name,
      email: guide.email,
    });
  }

  return {
    assignment: {
      id: row.id,
      timeslotId: row.timeslot_id,
      guideId: row.guide_id,
      guideName: guide.name,
      guideEmail: guide.email,
      roleLabel: row.role_label,
      createdAt: row.created_at,
    },
    created,
    notification,
  };
}

/** Remove a guide assignment by id. Idempotent (missing → false). */
export async function unassignGuide(operatorId: string, assignmentId: string): Promise<boolean> {
  const db = forOperator(operatorId);
  const existing = await db.guideAssignment.findUnique({
    where: { id: assignmentId },
    select: { id: true },
  });
  if (!existing) return false;
  await db.guideAssignment.delete({ where: { id: assignmentId } });
  return true;
}

/** List all guide assignments for a set of timeslots (manifest read). */
export async function listGuideAssignmentsForTimeslots(
  operatorId: string,
  timeslotIds: string[],
): Promise<GuideAssignmentView[]> {
  if (timeslotIds.length === 0) return [];
  const db = forOperator(operatorId);
  const rows = await db.guideAssignment.findMany({
    where: { timeslot_id: { in: timeslotIds } },
    include: { guide: { select: { id: true, name: true, email: true } } },
    orderBy: { created_at: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    timeslotId: r.timeslot_id,
    guideId: r.guide_id,
    guideName: r.guide.name,
    guideEmail: r.guide.email,
    roleLabel: r.role_label,
    createdAt: r.created_at,
  }));
}

/**
 * Email a guide (staff member) that they've been assigned to a trip. Never throws;
 * no-ops cleanly when Resend isn't configured. Loads the slot + activity + operator
 * branding through the RLS-scoped client. (StaffMember carries an email but no phone
 * in the schema, so email is the guide channel; SMS is reserved for customers.)
 */
async function notifyGuideAssigned(
  operatorId: string,
  timeslotId: string,
  guide: { id: string; name: string | null; email: string },
): Promise<NotificationResult> {
  try {
    const db = forOperator(operatorId);
    const slot = await db.timeslot.findUnique({
      where: { id: timeslotId },
      include: {
        activity: { include: { location: true } },
      },
    });
    if (!slot) return skipped('timeslot not found');

    const operator = await db.operator.findUnique({
      where: { id: operatorId },
      select: { name_external: true, timezone: true },
    });
    if (!operator) return skipped('operator not found');

    const timezone =
      slot.activity.location?.timezone ?? operator.timezone ?? 'America/Los_Angeles';

    return sendGuideAssignmentEmail({
      operatorId,
      brandName: operator.name_external,
      guideEmail: guide.email,
      guideName: guide.name,
      activityName: slot.activity.name_external,
      dateLabel: dateLabelFor(slot.datetime, timezone),
      timeLabel: timeLabelFor(slot.datetime, timezone),
      locationLabel: slot.activity.location?.name ?? undefined,
    });
  } catch (err) {
    console.error('[guides] notifyGuideAssigned failed:', err);
    return skipped('unexpected failure');
  }
}

export type { Prisma };
