/**
 * Activity detail route — slug resolution (live integration test against the
 * seeded LSRA tenant on Neon).
 *
 * GET /api/activities/:id must resolve an activity by EITHER its internal cuid
 * OR its stable catalog slug (stored in config.slug by seed-lakesonoma-catalog).
 * The slug path is what lets the marina's marketing site deep-link to a specific
 * activity with a URL that survives a reseed (cuids do not). Both paths must
 * return the same activity, and an unknown slug must 404.
 *
 * Skips without DATABASE_URL. Read-only — creates and deletes nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { app } from '../src/app.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
// A slug the LSRA catalog is guaranteed to have (see seed-lakesonoma-catalog.ts).
const ACTIVITY_SLUG = 'pontoon-5-person';

let activityId: string;

describe.skipIf(!HAS_DB)('activity detail slug resolution (live vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    const row = await adminPrisma.activity.findFirst({
      where: {
        operator_id: OP,
        status: 'ACTIVE',
        config: { path: ['slug'], equals: ACTIVITY_SLUG },
      },
      select: { id: true },
    });
    if (!row) {
      throw new Error(
        `No activity with config.slug="${ACTIVITY_SLUG}" in the LSRA seed — run the catalog sync.`,
      );
    }
    activityId = row.id;
  });

  it('resolves an activity by its catalog slug', async () => {
    const res = await app.request(`/api/activities/${ACTIVITY_SLUG}`, {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activity: { id: string } };
    expect(body.activity.id).toBe(activityId);
  });

  it('still resolves the same activity by its internal id', async () => {
    const res = await app.request(`/api/activities/${activityId}`, {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activity: { id: string } };
    expect(body.activity.id).toBe(activityId);
  });

  it('404s on an unknown slug', async () => {
    const res = await app.request('/api/activities/not-a-real-slug', {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(404);
  });
});
