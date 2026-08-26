/**
 * Guide scheduling API (Singenuity §2 day-of ops).
 *
 *   GET    /?timeslotIds=a,b,c   staff (order:read)  — list assignments for slots
 *   GET    /roster              staff (order:read)   — assignable guides (staff)
 *   POST   /                    staff (order:write)  — assign a guide to a timeslot
 *   DELETE /:id                 staff (order:write)  — remove an assignment
 *
 * All data access is tenant-scoped (RLS via the service's forOperator client). The
 * DB's tenant-composite FKs guarantee the guide + timeslot belong to this operator.
 * Assigning notifies the guide (email); the send no-ops without a Resend key.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import {
  assignGuide,
  unassignGuide,
  listGuideAssignmentsForTimeslots,
  GuideError,
} from '../services/guides.js';

export const guides = new Hono<Env>();

// --- GET / : list assignments for a set of timeslots ----------------------

guides.get('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:read');

  const raw = c.req.query('timeslotIds')?.trim();
  const timeslotIds = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const assignments = await listGuideAssignmentsForTimeslots(c.var.operatorId, timeslotIds);
  return c.json({ assignments });
});

// --- GET /roster : assignable guides (active staff of this operator) --------

guides.get('/roster', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:read');

  // Guides are staff; surface the GUIDE role first but allow any active staffer to
  // be scheduled to lead a trip (small operators wear multiple hats).
  const staff = await c.var.db.staffMember.findMany({
    where: { is_active: true },
    select: { id: true, name: true, email: true, role: true },
    orderBy: [{ name: 'asc' }],
  });
  const roster = staff
    .map((s) => ({ id: s.id, name: s.name, email: s.email, role: s.role }))
    .sort((a, b) => (a.role === 'GUIDE' ? -1 : 0) - (b.role === 'GUIDE' ? -1 : 0));
  return c.json({ guides: roster });
});

// --- POST / : assign a guide to a timeslot ---------------------------------

const assignSchema = z.object({
  timeslotId: z.string().min(1),
  guideId: z.string().min(1),
  roleLabel: z.string().max(60).optional(),
  /** Set false to skip the guide notification. */
  notify: z.boolean().optional(),
});

guides.post('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:write');

  const parsed = assignSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  try {
    const result = await assignGuide(c.var.operatorId, {
      timeslotId: parsed.data.timeslotId,
      guideId: parsed.data.guideId,
      roleLabel: parsed.data.roleLabel,
      notify: parsed.data.notify,
      actor: c.var.auth.userId,
    });
    return c.json(
      {
        assignment: result.assignment,
        created: result.created,
        notified: result.notification.sent,
      },
      result.created ? 201 : 200,
    );
  } catch (err) {
    if (err instanceof GuideError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});

// --- DELETE /:id : remove an assignment ------------------------------------

guides.delete('/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:write');

  const removed = await unassignGuide(c.var.operatorId, c.req.param('id'));
  if (!removed) return c.json({ error: 'Assignment not found' }, 404);
  return c.json({ ok: true });
});
