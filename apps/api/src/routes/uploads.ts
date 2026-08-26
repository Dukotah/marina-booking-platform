/**
 * Uploads — the HTTP half of the `storage` provider (services/storage.ts).
 *
 *   POST   /uploads?scope=branding&filename=logo.png   store an image  (staff)
 *   DELETE /uploads/:operatorId/:scope/:name           remove one      (staff)
 *   GET    /uploads/:operatorId/:scope/:name           serve one       (public)
 *
 * MOUNT IT AT THE TOP LEVEL, NOT UNDER /api — this router carries its own
 * `tenantMiddleware` on the two write verbs precisely so the GET can live
 * outside it. A logo is fetched by an `<img>` tag inside a customer's email
 * client and on the operator's own website: no `x-operator-slug` header exists
 * there, and on `localhost` there is no tenant subdomain either, so a serve
 * route behind the tenant middleware would 400 on every request. The tenant is
 * therefore a path segment, and the objects are public by design (see the
 * storage service's header — this driver is only ever for public assets).
 *
 * THE BODY IS RAW BYTES, NOT MULTIPART. Multipart would have to be buffered
 * before it could be parsed, which defeats the size cap; and `formData()` has no
 * cap of its own. Reading the raw stream lets us abort the moment a client goes
 * over the limit, and it costs the browser nothing (`xhr.send(file)`), while
 * keeping upload progress working. The original filename rides along as a query
 * parameter for the audit trail only; it never touches the disk, and it is not a
 * header because app.ts's CORS allow-list is fixed and not ours to edit.
 *
 * NOT yet mounted in app.ts — see the report.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { assertPermission, type Permission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import { tenantMiddleware } from '../middleware/tenant.js';
import { rateLimit, getClientIp } from '../middleware/rate-limit.js';
import { AUDIT_ACTIONS, recordAudit, staffActor } from '../services/audit.js';
import { sandboxEnabled } from '../services/sandbox.js';
import {
  StorageError,
  UPLOAD_SCOPES,
  UPLOAD_SCOPE_KEYS,
  buildObjectKey,
  deleteImage,
  formatBytes,
  isUploadScope,
  readLocalObject,
  storeImage,
  validateImageUpload,
  type UploadScope,
} from '../services/storage.js';

export const uploads = new Hono<Env>();

/**
 * Who may replace what. Branding is the operator's public identity, so it sits
 * behind `operator:manage` (OWNER only); an activity photo is catalog work a
 * manager does every week.
 */
const PERMISSION_BY_SCOPE: Record<UploadScope, Permission> = {
  branding: 'operator:manage',
  activity: 'activity:write',
};

/** Writing to disk is cheap but not free; keep a runaway client from filling it. */
const uploadLimit = rateLimit({ windowMs: 60_000, max: 60, bucket: 'uploads:write' });

function fail(c: Context<Env>, err: unknown): Response {
  if (err instanceof StorageError) {
    return c.json({ error: err.message, code: err.code }, err.status as 400);
  }
  throw err;
}

// ===========================================================================
// Serve  (public, local driver only)
// ===========================================================================

/**
 * Headers that make user-supplied bytes safe to hand a browser.
 *
 * `nosniff` pins the type we sniffed, so a GIF/HTML polyglot cannot be talked
 * into rendering as a document; the CSP makes the response inert even if some
 * future browser ignores that; `inline` + a year of immutable caching is right
 * because the name is random — the bytes behind a URL never change.
 */
function assetHeaders(contentType: string, size: number, etag: string, modified: Date) {
  return {
    'Content-Type': contentType,
    'Content-Length': String(size),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Last-Modified': modified.toUTCString(),
    ETag: etag,
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
}

uploads.on(['GET', 'HEAD'], '/:operatorId/:scope/:name', async (c) => {
  // In cloud mode the bytes live in R2 and are served from the bucket's own
  // public hostname; nothing was ever written here to serve.
  if (!sandboxEnabled()) return c.json({ error: 'Not found' }, 404);

  const { operatorId, scope, name } = c.req.param();
  let key: string;
  try {
    if (!isUploadScope(scope)) return c.json({ error: 'Not found' }, 404);
    key = buildObjectKey({ operatorId, scope, name });
  } catch {
    // A malformed key is an invented URL, not a missing file. Same answer
    // either way — never confirm what does or does not exist on disk.
    return c.json({ error: 'Not found' }, 404);
  }

  let object;
  try {
    object = await readLocalObject(key);
  } catch (err) {
    return fail(c, err);
  }
  if (!object) return c.json({ error: 'Not found' }, 404);

  const etag = `"${name}"`; // the name IS the content identity
  const headers = assetHeaders(object.contentType, object.size, etag, object.modified);

  if (c.req.header('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  if (c.req.method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.bytes, { status: 200, headers });
});

// ===========================================================================
// Upload
// ===========================================================================

/** Read the body, giving up the moment it exceeds `limit`. */
async function readCappedBody(
  request: Request,
  limit: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const stream = request.body;
  if (!stream) return { ok: true, bytes: new Uint8Array(0) };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** The client's filename, kept only for the audit row. Never a path. */
function safeDisplayName(raw: string | undefined): string | null {
  if (!raw) return null;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return cleaned ? cleaned.slice(0, 120) : null;
}

uploads.post('/', tenantMiddleware, requireStaff, uploadLimit, async (c) => {
  const scope = c.req.query('scope') ?? 'branding';
  if (!isUploadScope(scope)) {
    return c.json(
      {
        error: `Unknown upload scope "${scope}". Expected one of: ${UPLOAD_SCOPE_KEYS.join(', ')}.`,
        code: 'unknown_scope',
      },
      400,
    );
  }
  assertPermission(c.var.auth, PERMISSION_BY_SCOPE[scope]);

  const spec = UPLOAD_SCOPES[scope];
  const contentType = c.req.header('content-type') ?? null;

  if (contentType?.toLowerCase().startsWith('multipart/form-data')) {
    return c.json(
      {
        error: 'Send the image as the raw request body, not as a multipart form.',
        code: 'unsupported_encoding',
      },
      415,
    );
  }

  // Refuse an oversized upload from the headers alone, before a byte moves.
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > spec.maxBytes) {
    return c.json(
      {
        error: `That image is ${formatBytes(declared)}. A ${spec.noun} has to be under ${formatBytes(spec.maxBytes)} — try exporting it smaller.`,
        code: 'too_large',
      },
      413,
    );
  }

  const body = await readCappedBody(c.req.raw, spec.maxBytes);
  if (!body.ok) {
    return c.json(
      {
        error: `That image is over ${formatBytes(spec.maxBytes)}, which is the limit for a ${spec.noun}.`,
        code: 'too_large',
      },
      413,
    );
  }

  const validation = validateImageUpload({ scope, bytes: body.bytes, declaredType: contentType });
  if (!validation.ok) {
    return c.json({ error: validation.error.message, code: validation.error.code }, validation.error.status);
  }

  let stored;
  try {
    stored = await storeImage({
      operatorId: c.var.operatorId,
      scope,
      bytes: body.bytes,
      kind: validation.kind,
    });
  } catch (err) {
    return fail(c, err);
  }

  // An uploaded asset ends up on a public page and in customer email, so who
  // put it there is worth a row. `settings.update` is the closest existing
  // action — see the report; a dedicated `upload.create` would need audit.ts.
  await recordAudit({
    operatorId: c.var.operatorId,
    actor: staffActor(c.var.auth, getClientIp((h) => c.req.header(h))),
    action: AUDIT_ACTIONS.SETTINGS_UPDATE,
    entityType: 'Upload',
    entityId: stored.key,
    after: { key: stored.key, url: stored.url, content_type: stored.contentType, bytes: stored.bytes },
    context: {
      scope,
      driver: stored.driver,
      original_filename: safeDisplayName(c.req.query('filename')),
      declared_content_type: contentType,
    },
  });

  return c.json(
    {
      upload: {
        key: stored.key,
        url: stored.url,
        contentType: stored.contentType,
        bytes: stored.bytes,
        driver: stored.driver,
      },
    },
    201,
  );
});

// ===========================================================================
// Delete
// ===========================================================================

uploads.delete('/:operatorId/:scope/:name', tenantMiddleware, requireStaff, async (c) => {
  const { operatorId, scope, name } = c.req.param();
  if (!isUploadScope(scope)) return c.json({ error: 'Upload not found' }, 404);
  assertPermission(c.var.auth, PERMISSION_BY_SCOPE[scope]);

  let key: string;
  try {
    key = buildObjectKey({ operatorId, scope, name });
  } catch {
    return c.json({ error: 'Upload not found' }, 404);
  }

  let removed: boolean;
  try {
    // Cross-tenant deletes are refused inside deleteImage — storage is outside
    // Postgres, so this comparison is the whole tenant boundary here.
    removed = await deleteImage(c.var.operatorId, key);
  } catch (err) {
    return fail(c, err);
  }

  if (removed) {
    await recordAudit({
      operatorId: c.var.operatorId,
      actor: staffActor(c.var.auth, getClientIp((h) => c.req.header(h))),
      action: AUDIT_ACTIONS.SETTINGS_UPDATE,
      entityType: 'Upload',
      entityId: key,
      before: { key },
      context: { scope, deleted: true },
    });
  }

  return c.json({ ok: true, removed });
});
