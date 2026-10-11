/**
 * Waitlist — live integration test against the seeded LSRA tenant. Proves that:
 *   - joining a genuinely sold-out slot creates a PENDING entry;
 *   - a slot with room, a cancelled slot, a past slot, and an unknown slot are
 *     each rejected with the right code (you book room, you don't wait on it);
 *   - a repeat join by the same email upserts — it keeps the guest's place in
 *     line (created_at) rather than queuing them twice;
 *   - notifyWaitlistForTimeslots flips the oldest PENDING entries to NOTIFIED,
 *     but only up to the number of seats actually open on the slot;
 *   - a second sweep never re-notifies an already-NOTIFIED entry (the guarded
 *     status flip is the claim).
 *
 * Skips without DATABASE_URL. Cleans up everything it creates in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { app } from '../src/app.js';
import {
  joinWaitlist,
  notifyWaitlistForTimeslots,
  WaitlistError,
} from '../src/services/waitlist.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma'; // operator.slug -> resolves to operator id 'lsra'

let activityId = '';
let slotCapacity = 2;
const createdTimeslotIds: string[] = [];

describe.skipIf(!HAS_DB)('waitlist (live vs seeded LSRA)', () => {
  beforeAll(async () => {
    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true },
      },
      select: {
        activity_id: true,
        activity: { select: { min_participants: true, max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');
    activityId = rate.activity_id;
    slotCapacity = Math.max(rate.activity.max_participants, 2);
  });

  afterAll(async () => {
    // Waitlist entries cascade from the timeslot (FK onDelete: Cascade).
    for (const id of createdTimeslotIds) await adminPrisma.timeslot.deleteMany({ where: { id } });
    await adminPrisma.$disconnect();
  });

  /** A fresh, genuinely sold-out future slot (booked == total). */
  async function soldOutSlot(daysOut = 30) {
    const slot = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + daysOut * 24 * 60 * 60 * 1000),
        capacity_total: slotCapacity,
        capacity_booked: slotCapacity,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    createdTimeslotIds.push(slot.id);
    return slot.id;
  }

  /** Free `seats` on a slot so a notify sweep has room to offer. */
  async function free(timeslotId: string, seats: number) {
    await adminPrisma.timeslot.update({
      where: { id: timeslotId },
      data: { capacity_booked: Math.max(0, slotCapacity - seats) },
    });
  }

  it('joins a sold-out slot as PENDING', async () => {
    const slotId = await soldOutSlot();
    const entry = await joinWaitlist(OP, {
      timeslotId: slotId,
      name: 'Dana Waiter',
      email: 'Dana.Waiter@Example.com',
      phone: '(707) 555-0101',
    });
    expect(entry.status).toBe('PENDING');
    expect(entry.email).toBe('dana.waiter@example.com'); // normalized
    expect(entry.notified_at).toBeNull();
  });

  it('rejects a slot that still has room', async () => {
    const slot = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        capacity_total: slotCapacity,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    createdTimeslotIds.push(slot.id);
    await expect(
      joinWaitlist(OP, { timeslotId: slot.id, name: 'Too Eager', email: 'eager@example.com' }),
    ).rejects.toMatchObject({ code: 'SLOT_HAS_ROOM' });
  });

  it('rejects a cancelled slot, a past slot, and an unknown slot', async () => {
    const cancelled = await soldOutSlot();
    await adminPrisma.timeslot.update({ where: { id: cancelled }, data: { status: 'CANCELLED' } });
    await expect(
      joinWaitlist(OP, { timeslotId: cancelled, name: 'X', email: 'c@example.com' }),
    ).rejects.toMatchObject({ code: 'TIMESLOT_CANCELLED' });

    const past = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() - 24 * 60 * 60 * 1000),
        capacity_total: slotCapacity,
        capacity_booked: slotCapacity,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    createdTimeslotIds.push(past.id);
    await expect(
      joinWaitlist(OP, { timeslotId: past.id, name: 'X', email: 'p@example.com' }),
    ).rejects.toMatchObject({ code: 'TIMESLOT_PAST' });

    await expect(
      joinWaitlist(OP, { timeslotId: 'does-not-exist', name: 'X', email: 'n@example.com' }),
    ).rejects.toBeInstanceOf(WaitlistError);
  });

  it('a repeat join by the same email keeps the place in line (upsert, not duplicate)', async () => {
    const slotId = await soldOutSlot();
    const first = await joinWaitlist(OP, {
      timeslotId: slotId,
      name: 'Pat Repeat',
      email: 'pat@example.com',
    });
    const again = await joinWaitlist(OP, {
      timeslotId: slotId,
      name: 'Pat Repeat Updated',
      email: 'PAT@example.com', // same email, different case
      phone: '555-9999',
    });
    expect(again.id).toBe(first.id);
    expect(again.created_at.getTime()).toBe(first.created_at.getTime());
    expect(again.name).toBe('Pat Repeat Updated');
    expect(again.phone).toBe('555-9999');

    const count = await adminPrisma.waitlistEntry.count({ where: { timeslot_id: slotId } });
    expect(count).toBe(1);
  });

  it('notifies the oldest PENDING entries up to the open seats, and never twice', async () => {
    const slotId = await soldOutSlot();
    // Three guests, deterministically ordered by created_at.
    const base = Date.now() - 3 * 60 * 1000;
    const emails = ['first@example.com', 'second@example.com', 'third@example.com'];
    for (let i = 0; i < emails.length; i++) {
      await adminPrisma.waitlistEntry.create({
        data: {
          operator_id: OP,
          timeslot_id: slotId,
          name: `Guest ${i}`,
          email: emails[i],
          status: 'PENDING',
          created_at: new Date(base + i * 1000),
        },
      });
    }

    // One seat opens → exactly the oldest entry is notified.
    await free(slotId, 1);
    const r1 = await notifyWaitlistForTimeslots(OP, [slotId]);
    expect(r1.notified).toBe(1);
    const firstEntry = await adminPrisma.waitlistEntry.findFirst({
      where: { timeslot_id: slotId, email: 'first@example.com' },
    });
    expect(firstEntry?.status).toBe('NOTIFIED');
    expect(firstEntry?.notified_at).not.toBeNull();

    // Re-running with the same one open seat must NOT re-notify the first entry;
    // it may offer the seat to the next in line, but never double-notifies anyone.
    const beforeNotified = await adminPrisma.waitlistEntry.count({
      where: { timeslot_id: slotId, status: 'NOTIFIED' },
    });
    const r2 = await notifyWaitlistForTimeslots(OP, [slotId]);
    const afterNotified = await adminPrisma.waitlistEntry.count({
      where: { timeslot_id: slotId, status: 'NOTIFIED' },
    });
    // The first entry is already NOTIFIED (no longer counts against the seat), so
    // the second sweep offers that same open seat to the next oldest PENDING.
    expect(r2.notified).toBe(1);
    expect(afterNotified).toBe(beforeNotified + 1);
    const firstAgain = await adminPrisma.waitlistEntry.findUnique({ where: { id: firstEntry!.id } });
    expect(firstAgain?.notified_at?.getTime()).toBe(firstEntry?.notified_at?.getTime()); // untouched
  });
});

/**
 * The staff-only `POST /api/waitlist/notify` route the admin manifest's "Notify
 * next" button calls, exercised through the real Hono app (`app.request`), so it
 * covers the full wiring the server action depends on: tenant resolution, the
 * `requireStaff` + order:write gate, zod validation, and that it reuses the same
 * notify sweep (emails only up to the open seats). Removing entries is a direct
 * admin DB delete, not an API surface, so there is nothing to HTTP-test there.
 */
describe.skipIf(!HAS_DB)('POST /api/waitlist/notify (live HTTP, LSRA seed)', () => {
  let routeActivityId = '';
  let routeCapacity = 2;
  let createdStaff = false;
  const routeSlotIds: string[] = [];

  const staffHeaders = {
    'x-operator-slug': SLUG,
    'x-dev-staff-id': 'dev-owner',
    'content-type': 'application/json',
  };

  beforeAll(async () => {
    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true },
      },
      select: {
        activity_id: true,
        activity: { select: { max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');
    routeActivityId = rate.activity_id;
    routeCapacity = Math.max(rate.activity.max_participants, 2);

    // The dev shim resolves `x-dev-staff-id: dev-owner` to this staff row.
    const existing = await adminPrisma.staffMember.findFirst({
      where: { operator_id: OP, auth_user_id: 'dev-owner' },
      select: { id: true },
    });
    if (!existing) {
      await adminPrisma.staffMember.create({
        data: {
          operator_id: OP,
          auth_user_id: 'dev-owner',
          name: 'Dev Owner',
          email: 'dev-owner-waitlist-itest@example.com',
          role: 'OWNER',
          is_active: true,
        },
      });
      createdStaff = true;
    }
  });

  afterAll(async () => {
    for (const id of routeSlotIds) await adminPrisma.timeslot.deleteMany({ where: { id } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({
        where: { operator_id: OP, auth_user_id: 'dev-owner' },
      });
    }
    await adminPrisma.$disconnect();
  });

  async function soldOutSlotWithWaiter() {
    const slot = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: routeActivityId,
        datetime: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
        capacity_total: routeCapacity,
        capacity_booked: routeCapacity,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    routeSlotIds.push(slot.id);
    await adminPrisma.waitlistEntry.create({
      data: {
        operator_id: OP,
        timeslot_id: slot.id,
        name: 'Route Waiter',
        email: 'route.waiter@example.com',
        status: 'PENDING',
      },
    });
    return slot.id;
  }

  it('rejects an unauthenticated (no staff) caller', async () => {
    const slotId = await soldOutSlotWithWaiter();
    const res = await app.request('/api/waitlist/notify', {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ timeslotId: slotId }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed body', async () => {
    const res = await app.request('/api/waitlist/notify', {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('is a no-op while the slot is still full (nobody emailed)', async () => {
    const slotId = await soldOutSlotWithWaiter();
    const res = await app.request('/api/waitlist/notify', {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ timeslotId: slotId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, notified: 0 });
    const entry = await adminPrisma.waitlistEntry.findFirst({ where: { timeslot_id: slotId } });
    expect(entry?.status).toBe('PENDING'); // untouched — no seat opened
  });

  it('notifies the waiting guest once a seat opens', async () => {
    const slotId = await soldOutSlotWithWaiter();
    // Free one seat, then hand-trigger the sweep from the route.
    await adminPrisma.timeslot.update({
      where: { id: slotId },
      data: { capacity_booked: routeCapacity - 1 },
    });
    const res = await app.request('/api/waitlist/notify', {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ timeslotId: slotId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, notified: 1 });
    const entry = await adminPrisma.waitlistEntry.findFirst({ where: { timeslot_id: slotId } });
    expect(entry?.status).toBe('NOTIFIED');
    expect(entry?.notified_at).not.toBeNull();
  });
});
