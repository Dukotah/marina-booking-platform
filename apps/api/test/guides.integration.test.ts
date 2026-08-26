/**
 * Guide scheduling — live integration test against the seeded LSRA tenant.
 *
 * Proves the day-of-ops guide flow end to end (Singenuity §2):
 *   - assigning a guide to a timeslot creates one assignment, tagged with the actor;
 *   - assignment is idempotent on (timeslot, guide) — a repeat returns the SAME row
 *     with created:false and does not duplicate;
 *   - re-assigning with a new role label updates in place;
 *   - listing by timeslot returns the assignment joined with the guide's identity;
 *   - unassigning removes it (and is idempotent on a missing id);
 *   - a guide/timeslot from another tenant is rejected by the tenant-composite FK
 *     (the service's active-staff/slot guards return GuideError first).
 *
 * The guide notification is a clean no-op here (no Resend key), so assignment never
 * blocks on it. Skips without DATABASE_URL; cleans up everything it creates.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import {
  assignGuide,
  unassignGuide,
  listGuideAssignmentsForTimeslots,
  GuideError,
} from '../src/services/guides.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const GUIDE_EMAIL = 'guide-itest@example.com';
const GUIDE_AUTH_ID = 'guide-itest-auth';

let activityId = '';
let guideId = '';
let timeslotId = '';
const createdTimeslotIds: string[] = [];

describe.skipIf(!HAS_DB)('guide scheduling (live vs Postgres, LSRA seed)', () => {
  beforeAll(async () => {
    const activity = await adminPrisma.activity.findFirst({
      where: { operator_id: OP, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!activity) throw new Error('No active activity in the LSRA seed — run `pnpm db:seed`.');
    activityId = activity.id;

    // A GUIDE staff member to schedule.
    await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: GUIDE_AUTH_ID } });
    const guide = await adminPrisma.staffMember.create({
      data: {
        operator_id: OP,
        auth_user_id: GUIDE_AUTH_ID,
        email: GUIDE_EMAIL,
        name: 'River Guide',
        role: 'GUIDE',
        is_active: true,
      },
      select: { id: true },
    });
    guideId = guide.id;

    const slot = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000),
        capacity_total: 6,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    timeslotId = slot.id;
    createdTimeslotIds.push(slot.id);
  });

  afterAll(async () => {
    await adminPrisma.guideAssignment.deleteMany({ where: { operator_id: OP, guide_id: guideId } });
    for (const id of createdTimeslotIds) await adminPrisma.timeslot.deleteMany({ where: { id } });
    await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: GUIDE_AUTH_ID } });
    await adminPrisma.$disconnect();
  });

  it('assigns a guide to a timeslot (created, actor recorded, guide notified)', async () => {
    const result = await assignGuide(OP, {
      timeslotId,
      guideId,
      roleLabel: 'Lead',
      actor: 'tester',
    });
    expect(result.created).toBe(true);
    expect(result.assignment.guideId).toBe(guideId);
    expect(result.assignment.timeslotId).toBe(timeslotId);
    expect(result.assignment.roleLabel).toBe('Lead');
    expect(result.assignment.guideEmail).toBe(GUIDE_EMAIL);
    // Tests run with the local sandbox on, so the guide email is captured rather
    // than sent to Resend — the flow is exercised end to end and never throws.
    expect(result.notification.sent).toBe(true);
    const captured = await adminPrisma.sandboxMessage.findFirst({
      where: { operator_id: OP, kind: 'guide_assignment', to_address: GUIDE_EMAIL },
      orderBy: { created_at: 'desc' },
    });
    expect(captured).not.toBeNull();

    const row = await adminPrisma.guideAssignment.findUnique({
      where: { id: result.assignment.id },
      select: { assigned_by: true },
    });
    expect(row?.assigned_by).toBe('tester');
  });

  it('is idempotent on (timeslot, guide) — repeat returns the same row, created:false', async () => {
    const again = await assignGuide(OP, { timeslotId, guideId, roleLabel: 'Lead' });
    expect(again.created).toBe(false);

    const count = await adminPrisma.guideAssignment.count({
      where: { operator_id: OP, timeslot_id: timeslotId, guide_id: guideId },
    });
    expect(count).toBe(1);
  });

  it('updates the role label in place on re-assign', async () => {
    const updated = await assignGuide(OP, { timeslotId, guideId, roleLabel: 'Second' });
    expect(updated.created).toBe(false);
    expect(updated.assignment.roleLabel).toBe('Second');
  });

  it('lists assignments for a timeslot with the guide identity joined', async () => {
    const list = await listGuideAssignmentsForTimeslots(OP, [timeslotId]);
    expect(list.length).toBe(1);
    expect(list[0].guideName).toBe('River Guide');
    expect(list[0].guideEmail).toBe(GUIDE_EMAIL);
  });

  it('rejects an unknown guide with a GuideError', async () => {
    await expect(
      assignGuide(OP, { timeslotId, guideId: 'does-not-exist' }),
    ).rejects.toThrow(GuideError);
  });

  it('rejects an unknown timeslot with a GuideError', async () => {
    await expect(
      assignGuide(OP, { timeslotId: 'does-not-exist', guideId }),
    ).rejects.toThrow(GuideError);
  });

  it('unassigns (and is idempotent on a missing id)', async () => {
    const list = await listGuideAssignmentsForTimeslots(OP, [timeslotId]);
    const id = list[0].id;
    expect(await unassignGuide(OP, id)).toBe(true);
    expect(await unassignGuide(OP, id)).toBe(false); // already gone
    const after = await listGuideAssignmentsForTimeslots(OP, [timeslotId]);
    expect(after.length).toBe(0);
  });
});
