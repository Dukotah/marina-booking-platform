/**
 * Waiver editor CRUD — live HTTP integration test against the seeded LSRA tenant.
 * Proves the legal-critical contract of the staff editor endpoints:
 *
 *   - every TEXT change (waiver name/intro, clause create/edit/delete/reorder)
 *     bumps Waiver.version in the same transaction,
 *   - no-op edits and policy toggles do NOT bump the version,
 *   - existing WaiverSignature rows are IMMUTABLE across edits (snapshot_html +
 *     waiver_version keep exactly what was agreed to), while new signatures pick
 *     up the new version/text, and
 *   - the endpoints are staff-gated (401 unauthenticated).
 *
 * Skips without DATABASE_URL. Creates its own (temporarily active) waiver, its
 * own booking, and (if missing) the dev-owner staff row; deletes everything in
 * afterAll so the seed waiver becomes active again.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { app } from '../src/app.js';
import { createBooking } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const TEST_EMAIL = 'waiver-editor-itest@example.com';

const publicJson = { 'x-operator-slug': SLUG, 'content-type': 'application/json' };
const staffJson = {
  'x-operator-slug': SLUG,
  'x-dev-staff-id': 'dev-owner',
  'content-type': 'application/json',
};

let waiverId = '';
let clauseAId = '';
let clauseBId = '';
let timeslotId = '';
let orderId = '';
let orderItemId = '';
let createdStaff = false;

async function currentVersion(): Promise<number> {
  const w = await adminPrisma.waiver.findUnique({
    where: { id: waiverId },
    select: { version: true },
  });
  return w!.version;
}

async function activeWaiver(): Promise<{
  waiver: {
    id: string;
    name: string;
    version: number;
    clauses: Array<{ id: string; title: string; sortOrder: number; isRequired: boolean; requiresInitials: boolean }>;
  };
}> {
  const res = await app.request('/api/waivers/active', { headers: { 'x-operator-slug': SLUG } });
  expect(res.status).toBe(200);
  return (await res.json()) as Awaited<ReturnType<typeof activeWaiver>>;
}

describe.skipIf(!HAS_DB)('waiver editor API (live HTTP, LSRA seed)', () => {
  beforeAll(async () => {
    const existingStaff = await adminPrisma.staffMember.findFirst({
      where: { operator_id: OP, auth_user_id: 'dev-owner' },
      select: { id: true },
    });
    if (!existingStaff) {
      const loc = await adminPrisma.location.findFirst({
        where: { operator_id: OP },
        select: { id: true },
      });
      await adminPrisma.staffMember.create({
        data: {
          operator_id: OP,
          auth_user_id: 'dev-owner',
          name: 'Dev Owner',
          email: 'dev-owner@example.com',
          role: 'OWNER',
          is_active: true,
          locations: loc ? { create: { location_id: loc.id } } : undefined,
        },
      });
      createdStaff = true;
    }

    // A dedicated waiver, created LAST so GET /active + POST /sign resolve to it
    // (most recently created active waiver wins). Torn down in afterAll.
    const waiver = await adminPrisma.waiver.create({
      data: {
        operator_id: OP,
        name: 'Editor Test Waiver',
        template_html: '',
        intro_html: '<p>Original intro.</p>',
        version: 1,
        is_active: true,
        clauses: {
          // operator_id comes from the composite relation (operator_id, waiver_id).
          create: [
            {
              sort_order: 0,
              title: 'Assumption of Risk',
              body_html: '<p>Original risk text.</p>',
              requires_initials: true,
              is_required: true,
            },
            {
              sort_order: 1,
              title: 'Equipment Care',
              body_html: '<p>Original equipment text.</p>',
              requires_initials: true,
              is_required: true,
            },
          ],
        },
      },
      include: { clauses: { orderBy: { sort_order: 'asc' } } },
    });
    waiverId = waiver.id;
    clauseAId = waiver.clauses[0]!.id;
    clauseBId = waiver.clauses[1]!.id;

    // A booking to hang signatures on.
    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true },
      },
      select: {
        id: true,
        activity_id: true,
        activity: { select: { min_participants: true, max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');

    const db = forOperator(OP);
    const slot = await db.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: rate.activity_id,
        datetime: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000),
        capacity_total: rate.activity.max_participants,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    timeslotId = slot.id;

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    const order = await createBooking(
      OP,
      {
        activityId: rate.activity_id,
        rateId: rate.id,
        timeslotId,
        quantity: rate.activity.min_participants,
        customer: { first_name: 'Editor', last_name: 'Signer', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    orderId = order.id;
    const item = await adminPrisma.orderItem.findFirst({
      where: { order_id: orderId },
      select: { id: true },
    });
    orderItemId = item!.id;
  });

  afterAll(async () => {
    if (waiverId) {
      await adminPrisma.waiverSignature.deleteMany({ where: { waiver_id: waiverId } });
      await adminPrisma.waiver.deleteMany({ where: { id: waiverId } }); // clauses cascade
    }
    if (orderId) await adminPrisma.order.deleteMany({ where: { id: orderId } });
    if (timeslotId) await adminPrisma.timeslot.deleteMany({ where: { id: timeslotId } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({
        where: { operator_id: OP, auth_user_id: 'dev-owner' },
      });
    }
    await adminPrisma.$disconnect();
  });

  it('rejects unauthenticated editor calls (401)', async () => {
    const res = await app.request(`/api/waivers/manage/${waiverId}`, {
      method: 'PATCH',
      headers: publicJson,
      body: JSON.stringify({ name: 'Hacked' }),
    });
    expect(res.status).toBe(401);
    expect(await currentVersion()).toBe(1);
  });

  it('bumps the version when the waiver name/intro text changes', async () => {
    const res = await app.request(`/api/waivers/manage/${waiverId}`, {
      method: 'PATCH',
      headers: staffJson,
      body: JSON.stringify({ name: 'Editor Test Waiver v2', introHtml: '<p>Updated intro.</p>' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { waiver: { version: number } };
    expect(body.waiver.version).toBe(2);
    expect(await currentVersion()).toBe(2);

    const { waiver } = await activeWaiver();
    expect(waiver.name).toBe('Editor Test Waiver v2');
  });

  it('does NOT bump the version on a no-op text edit or a policy toggle', async () => {
    // Identical text → no bump.
    const noop = await app.request(`/api/waivers/manage/${waiverId}`, {
      method: 'PATCH',
      headers: staffJson,
      body: JSON.stringify({ name: 'Editor Test Waiver v2', introHtml: '<p>Updated intro.</p>' }),
    });
    expect(noop.status).toBe(200);
    expect(await currentVersion()).toBe(2);

    // Minor-signature policy is not customer-visible text → no bump.
    const toggle = await app.request(`/api/waivers/manage/${waiverId}`, {
      method: 'PATCH',
      headers: staffJson,
      body: JSON.stringify({ requiresMinorSignature: false }),
    });
    expect(toggle.status).toBe(200);
    expect(await currentVersion()).toBe(2);
    const row = await adminPrisma.waiver.findUnique({
      where: { id: waiverId },
      select: { requires_minor_signature: true },
    });
    expect(row!.requires_minor_signature).toBe(false);
  });

  it('adds a clause at the end and bumps the version', async () => {
    const res = await app.request(`/api/waivers/manage/${waiverId}/clauses`, {
      method: 'POST',
      headers: staffJson,
      body: JSON.stringify({
        title: 'Photo Release',
        bodyHtml: '<p>Optional photo clause.</p>',
        requiresInitials: true,
        isRequired: false,
      }),
    });
    expect(res.status).toBe(200);
    expect(await currentVersion()).toBe(3);

    const { waiver } = await activeWaiver();
    expect(waiver.clauses.map((c) => c.title)).toEqual([
      'Assumption of Risk',
      'Equipment Care',
      'Photo Release',
    ]);
  });

  it('reorders clauses (bump) and no-ops moving past the ends (no bump)', async () => {
    const up = await app.request(`/api/waivers/manage/clauses/${clauseBId}/move`, {
      method: 'POST',
      headers: staffJson,
      body: JSON.stringify({ direction: 'up' }),
    });
    expect(up.status).toBe(200);
    expect(await currentVersion()).toBe(4);

    let { waiver } = await activeWaiver();
    expect(waiver.clauses.map((c) => c.title)).toEqual([
      'Equipment Care',
      'Assumption of Risk',
      'Photo Release',
    ]);

    // Already first — moving up again changes nothing and must not bump.
    const past = await app.request(`/api/waivers/manage/clauses/${clauseBId}/move`, {
      method: 'POST',
      headers: staffJson,
      body: JSON.stringify({ direction: 'up' }),
    });
    expect(past.status).toBe(200);
    expect(await currentVersion()).toBe(4);

    // Restore the original order for the tests below.
    const down = await app.request(`/api/waivers/manage/clauses/${clauseBId}/move`, {
      method: 'POST',
      headers: staffJson,
      body: JSON.stringify({ direction: 'down' }),
    });
    expect(down.status).toBe(200);
    expect(await currentVersion()).toBe(5);
    ({ waiver } = await activeWaiver());
    expect(waiver.clauses.map((c) => c.title)).toEqual([
      'Assumption of Risk',
      'Equipment Care',
      'Photo Release',
    ]);
  });

  it('keeps an existing signature byte-identical while an edit bumps the version', async () => {
    // Sign at the current version (5) with the current text.
    const { waiver } = await activeWaiver();
    const acks = waiver.clauses
      .filter((c) => c.isRequired || c.requiresInitials)
      .map((c) => ({ clauseId: c.id, initials: 'ES' }));
    const signRes = await app.request('/api/waivers/sign', {
      method: 'POST',
      headers: publicJson,
      body: JSON.stringify({
        orderItemId,
        signerName: 'Editor Signer',
        signatureData: 'typed:Editor Signer',
        isMinor: false,
        acknowledgments: acks,
      }),
    });
    expect(signRes.status).toBe(201);
    const signed = (await signRes.json()) as { signature: { id: string; waiverVersion: number } };
    expect(signed.signature.waiverVersion).toBe(5);

    const before = await adminPrisma.waiverSignature.findUnique({
      where: { id: signed.signature.id },
      select: { snapshot_html: true, waiver_version: true, acknowledgments: true },
    });
    expect(before!.snapshot_html).toContain('Original risk text');

    // Rewrite the clause the customer initialed.
    const edit = await app.request(`/api/waivers/manage/clauses/${clauseAId}`, {
      method: 'PATCH',
      headers: staffJson,
      body: JSON.stringify({
        title: 'Assumption of Risk (revised)',
        bodyHtml: '<p>REVISED risk text.</p>',
      }),
    });
    expect(edit.status).toBe(200);
    expect(await currentVersion()).toBe(6);

    // THE invariant: the stored signature is untouched — same snapshot, same
    // version, same acknowledgments. History cannot be rewritten by an edit.
    const after = await adminPrisma.waiverSignature.findUnique({
      where: { id: signed.signature.id },
      select: { snapshot_html: true, waiver_version: true, acknowledgments: true },
    });
    expect(after!.snapshot_html).toBe(before!.snapshot_html);
    expect(after!.waiver_version).toBe(5);
    expect(after!.acknowledgments).toEqual(before!.acknowledgments);
    expect(after!.snapshot_html).toContain('Original risk text');
    expect(after!.snapshot_html).not.toContain('REVISED');

    // A NEW signature picks up the new version + new text.
    const acks2 = acks;
    const signRes2 = await app.request('/api/waivers/sign', {
      method: 'POST',
      headers: publicJson,
      body: JSON.stringify({
        orderItemId,
        signerName: 'Second Signer',
        signatureData: 'typed:Second Signer',
        isMinor: false,
        acknowledgments: acks2,
      }),
    });
    expect(signRes2.status).toBe(201);
    const signed2 = (await signRes2.json()) as { signature: { id: string; waiverVersion: number } };
    expect(signed2.signature.waiverVersion).toBe(6);
    const row2 = await adminPrisma.waiverSignature.findUnique({
      where: { id: signed2.signature.id },
      select: { snapshot_html: true },
    });
    expect(row2!.snapshot_html).toContain('REVISED risk text');
  });

  it('does not bump the version when a clause edit changes nothing', async () => {
    const res = await app.request(`/api/waivers/manage/clauses/${clauseAId}`, {
      method: 'PATCH',
      headers: staffJson,
      body: JSON.stringify({ title: 'Assumption of Risk (revised)' }),
    });
    expect(res.status).toBe(200);
    expect(await currentVersion()).toBe(6);
  });

  it('deletes a clause (bump) without touching stored acknowledgments', async () => {
    const { waiver } = await activeWaiver();
    const photo = waiver.clauses.find((c) => c.title === 'Photo Release')!;

    const res = await app.request(`/api/waivers/manage/clauses/${photo.id}`, {
      method: 'DELETE',
      headers: staffJson,
    });
    expect(res.status).toBe(200);
    expect(await currentVersion()).toBe(7);

    const { waiver: afterDelete } = await activeWaiver();
    expect(afterDelete.clauses.map((c) => c.title)).toEqual([
      'Assumption of Risk (revised)',
      'Equipment Care',
    ]);

    // The signature captured before the delete still records the clause.
    const sig = await adminPrisma.waiverSignature.findFirst({
      where: { waiver_id: waiverId },
      orderBy: { signed_at: 'asc' },
      select: { acknowledgments: true },
    });
    const titles = (sig!.acknowledgments as Array<{ title: string }>).map((a) => a.title);
    expect(titles).toContain('Photo Release');
  });

  it('404s on unknown clause / waiver ids and 400s on bad payloads', async () => {
    const missingClause = await app.request('/api/waivers/manage/clauses/nope', {
      method: 'PATCH',
      headers: staffJson,
      body: JSON.stringify({ title: 'X' }),
    });
    expect(missingClause.status).toBe(404);

    const missingWaiver = await app.request('/api/waivers/manage/nope/clauses', {
      method: 'POST',
      headers: staffJson,
      body: JSON.stringify({ title: 'X', bodyHtml: '<p>x</p>' }),
    });
    expect(missingWaiver.status).toBe(404);

    const badMove = await app.request(`/api/waivers/manage/clauses/${clauseAId}/move`, {
      method: 'POST',
      headers: staffJson,
      body: JSON.stringify({ direction: 'sideways' }),
    });
    expect(badMove.status).toBe(400);

    const emptyClause = await app.request(`/api/waivers/manage/${waiverId}/clauses`, {
      method: 'POST',
      headers: staffJson,
      body: JSON.stringify({ title: '', bodyHtml: '' }),
    });
    expect(emptyClause.status).toBe(400);
    expect(await currentVersion()).toBe(7);
  });

  it('records waiver.edit audit rows for editor mutations', async () => {
    const count = await adminPrisma.auditLog.count({
      where: { operator_id: OP, action: 'waiver.edit', entity_id: waiverId },
    });
    // name edit, clause add, 2 real moves, clause edit, delete — the no-ops
    // audit too (an attempted edit is still an event), so at least 6.
    expect(count).toBeGreaterThanOrEqual(6);

    // Cleanup our audit rows so reruns stay deterministic-ish.
    await adminPrisma.auditLog.deleteMany({
      where: { operator_id: OP, action: 'waiver.edit', entity_id: waiverId },
    });
  });
});

/**
 * xss-02 regression — a privileged author (operator:manage) cannot smuggle an
 * executable HTML payload into the waiver intro or a clause body. Both are
 * rendered raw via dangerouslySetInnerHTML on the public signer, the editor
 * preview, and the IMMUTABLE legal packet, so the payload must be stripped at the
 * write boundary (allowlist sanitizer, same policy as activity description_html)
 * AND never survive into a signed snapshot. Self-contained: own waiver + booking,
 * torn down in afterAll. Pre-fix this FAILS (onerror/script survive); post-fix the
 * stored intro/body, GET /active, and the signed snapshot all carry safe markup
 * only.
 */
describe.skipIf(!HAS_DB)('xss-02: waiver intro/clause HTML is sanitized (live HTTP, LSRA seed)', () => {
  const XSS_EMAIL = 'waiver-xss02-itest@example.com';
  let xWaiverId = '';
  let xClauseId = '';
  let xTimeslotId = '';
  let xOrderId = '';
  let xOrderItemId = '';
  let xCreatedStaff = false;

  const PAYLOAD = '<p>Safe lead-in.</p><img src=x onerror="fetch(`/evil`)"><script>alert(1)</script>';

  beforeAll(async () => {
    const existingStaff = await adminPrisma.staffMember.findFirst({
      where: { operator_id: OP, auth_user_id: 'dev-owner' },
      select: { id: true },
    });
    if (!existingStaff) {
      const loc = await adminPrisma.location.findFirst({
        where: { operator_id: OP },
        select: { id: true },
      });
      await adminPrisma.staffMember.create({
        data: {
          operator_id: OP,
          auth_user_id: 'dev-owner',
          name: 'Dev Owner',
          email: 'dev-owner@example.com',
          role: 'OWNER',
          is_active: true,
          locations: loc ? { create: { location_id: loc.id } } : undefined,
        },
      });
      xCreatedStaff = true;
    }

    // Created LAST so GET /active + POST /sign resolve to this waiver.
    const waiver = await adminPrisma.waiver.create({
      data: {
        operator_id: OP,
        name: 'XSS02 Test Waiver',
        template_html: '',
        intro_html: '<p>Clean intro.</p>',
        version: 1,
        is_active: true,
        clauses: {
          create: [
            {
              sort_order: 0,
              title: 'Assumption of Risk',
              body_html: '<p>Clean risk text.</p>',
              requires_initials: true,
              is_required: true,
            },
          ],
        },
      },
      include: { clauses: { orderBy: { sort_order: 'asc' } } },
    });
    xWaiverId = waiver.id;
    xClauseId = waiver.clauses[0]!.id;

    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true },
      },
      select: {
        id: true,
        activity_id: true,
        activity: { select: { min_participants: true, max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');

    const db = forOperator(OP);
    const slot = await db.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: rate.activity_id,
        datetime: new Date(Date.now() + 34 * 24 * 60 * 60 * 1000),
        capacity_total: rate.activity.max_participants,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    xTimeslotId = slot.id;

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: XSS_EMAIL } });
    const order = await createBooking(
      OP,
      {
        activityId: rate.activity_id,
        rateId: rate.id,
        timeslotId: xTimeslotId,
        quantity: rate.activity.min_participants,
        customer: { first_name: 'Xss', last_name: 'Signer', email: XSS_EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    xOrderId = order.id;
    const item = await adminPrisma.orderItem.findFirst({
      where: { order_id: xOrderId },
      select: { id: true },
    });
    xOrderItemId = item!.id;
  });

  afterAll(async () => {
    if (xWaiverId) {
      await adminPrisma.waiverSignature.deleteMany({ where: { waiver_id: xWaiverId } });
      await adminPrisma.waiver.deleteMany({ where: { id: xWaiverId } });
    }
    if (xOrderId) await adminPrisma.order.deleteMany({ where: { id: xOrderId } });
    if (xTimeslotId) await adminPrisma.timeslot.deleteMany({ where: { id: xTimeslotId } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: XSS_EMAIL } });
    await adminPrisma.auditLog.deleteMany({
      where: { operator_id: OP, action: 'waiver.edit', entity_id: xWaiverId },
    });
    if (xCreatedStaff) {
      await adminPrisma.staffMember.deleteMany({
        where: { operator_id: OP, auth_user_id: 'dev-owner' },
      });
    }
    await adminPrisma.$disconnect();
  });

  it('strips script/on* out of introHtml on write and in GET /active', async () => {
    const res = await app.request(`/api/waivers/manage/${xWaiverId}`, {
      method: 'PATCH',
      headers: staffJson,
      body: JSON.stringify({ introHtml: PAYLOAD }),
    });
    expect(res.status).toBe(200);

    const stored = await adminPrisma.waiver.findUnique({
      where: { id: xWaiverId },
      select: { intro_html: true },
    });
    const introLc = (stored!.intro_html ?? '').toLowerCase();
    expect(introLc).not.toContain('onerror');
    expect(introLc).not.toContain('<script');
    expect(stored!.intro_html).toContain('Safe lead-in.');

    const activeRes = await app.request('/api/waivers/active', {
      headers: { 'x-operator-slug': SLUG },
    });
    const active = (await activeRes.json()) as { waiver: { introHtml: string } };
    const activeLc = active.waiver.introHtml.toLowerCase();
    expect(activeLc).not.toContain('onerror');
    expect(activeLc).not.toContain('<script');
  });

  it('strips script/on* out of clause bodyHtml on write and in GET /active', async () => {
    const res = await app.request(`/api/waivers/manage/clauses/${xClauseId}`, {
      method: 'PATCH',
      headers: staffJson,
      body: JSON.stringify({ bodyHtml: PAYLOAD }),
    });
    expect(res.status).toBe(200);

    const stored = await adminPrisma.waiverClause.findUnique({
      where: { id: xClauseId },
      select: { body_html: true },
    });
    const bodyLc = stored!.body_html.toLowerCase();
    expect(bodyLc).not.toContain('onerror');
    expect(bodyLc).not.toContain('<script');
    expect(stored!.body_html).toContain('Safe lead-in.');

    const activeRes = await app.request('/api/waivers/active', {
      headers: { 'x-operator-slug': SLUG },
    });
    const active = (await activeRes.json()) as { waiver: { clauses: Array<{ bodyHtml: string }> } };
    const activeLc = active.waiver.clauses[0]!.bodyHtml.toLowerCase();
    expect(activeLc).not.toContain('onerror');
    expect(activeLc).not.toContain('<script');
  });

  it('never embeds an executable payload in the immutable signed snapshot', async () => {
    // Even if a raw payload somehow sat in the DB, buildSnapshotHtml re-sanitizes
    // intro + clause body before freezing them into the legal record. Force a raw
    // row directly (bypassing the write boundary) to prove render-time defense.
    await adminPrisma.waiver.update({
      where: { id: xWaiverId },
      data: { intro_html: PAYLOAD },
    });
    await adminPrisma.waiverClause.update({
      where: { id: xClauseId },
      data: { body_html: PAYLOAD },
    });

    const signRes = await app.request('/api/waivers/sign', {
      method: 'POST',
      headers: publicJson,
      body: JSON.stringify({
        orderItemId: xOrderItemId,
        signerName: 'Xss Signer',
        signatureData: 'typed:Xss Signer',
        isMinor: false,
        acknowledgments: [{ clauseId: xClauseId, initials: 'XS' }],
      }),
    });
    expect(signRes.status).toBe(201);
    const signed = (await signRes.json()) as { signature: { id: string } };

    const row = await adminPrisma.waiverSignature.findUnique({
      where: { id: signed.signature.id },
      select: { snapshot_html: true },
    });
    const snapLc = row!.snapshot_html!.toLowerCase();
    expect(snapLc).not.toContain('onerror');
    expect(snapLc).not.toContain('<script');
    expect(row!.snapshot_html).toContain('Safe lead-in.');
  });
});
