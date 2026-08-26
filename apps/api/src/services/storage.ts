/**
 * Storage provider — the `storage` row of docs/LOCAL-FIRST-BUILD.md §4.1.
 *
 * Two drivers behind one interface, selected by the same `sandboxEnabled()` rule
 * every other provider uses:
 *
 *   local -> the file lands under `.sandbox/uploads/<operator>/<scope>/<name>`
 *            and is served back by `routes/uploads.ts`. No account, no network.
 *   cloud -> Cloudflare R2, over its S3 API, signed with SigV4 using nothing but
 *            `node:crypto` and `fetch`. No SDK and no new dependency, so the
 *            cloud path compiles and typechecks on a laptop with no R2 bucket
 *            (it only fails when actually called without credentials).
 *
 * WHAT THIS DRIVER IS FOR. Every object here is public-by-URL: a logo has to load
 * inside a customer's email client and on an operator's own website, where no
 * cookie or Authorization header of ours exists. That is exactly what an R2
 * public bucket is, and the local driver matches it — the serve route is
 * deliberately unauthenticated. Nothing private may use this driver; a private
 * object needs signed, expiring URLs, which is a different provider.
 *
 * UPLOADS ARE HOSTILE INPUT, so:
 *   - the type comes from the file's own magic bytes, never from the extension
 *     and never from the browser's `Content-Type` (both are attacker-chosen);
 *   - only the five raster image formats below are accepted — notably NOT SVG,
 *     which is a script-bearing document that would run on our own origin;
 *   - the stored name is 16 random bytes plus an extension WE choose from the
 *     sniffed type, so no byte of the client's filename ever reaches the disk;
 *   - keys are re-validated on the way out and the resolved path is asserted to
 *     sit under the upload root, which makes traversal structurally impossible
 *     rather than merely unlikely;
 *   - the size cap is enforced while reading the body (see the route), because a
 *     cap checked after buffering is not a cap.
 *
 * A polyglot file (valid GIF header, HTML tail) still sniffs as a GIF — that is
 * inherent to magic bytes. The serve route neutralises it with `nosniff`, a
 * fixed image `Content-Type`, and a `default-src 'none'; sandbox` CSP, so the
 * browser will render it as an image or not at all.
 *
 * Times are UTC. No money passes through here.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { sandboxEnabled } from './sandbox.js';

// ===========================================================================
// Errors
// ===========================================================================

/** A storage failure with the HTTP status the route should return. */
export class StorageError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

// ===========================================================================
// Accepted image types
// ===========================================================================

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif';

/**
 * The only types we store, with the extension and `Content-Type` WE assign.
 * This map is the single source of truth in both directions: `put` writes the
 * extension from here, and the serve route reads the content type back from
 * here. They cannot drift, so a stored object can never be served as something
 * other than what was sniffed.
 */
export const IMAGE_TYPES: Record<ImageKind, { ext: string; mime: string; label: string }> = {
  png: { ext: 'png', mime: 'image/png', label: 'PNG' },
  jpeg: { ext: 'jpg', mime: 'image/jpeg', label: 'JPEG' },
  gif: { ext: 'gif', mime: 'image/gif', label: 'GIF' },
  webp: { ext: 'webp', mime: 'image/webp', label: 'WebP' },
  avif: { ext: 'avif', mime: 'image/avif', label: 'AVIF' },
};

/** Extension -> content type, for the serve path. Derived, never hand-kept. */
export const CONTENT_TYPE_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.values(IMAGE_TYPES).map((t) => [t.ext, t.mime]),
);

/** Human list for error copy: "PNG, JPEG, GIF, WebP or AVIF". */
export const ACCEPTED_IMAGE_LABEL = (() => {
  const labels = Object.values(IMAGE_TYPES).map((t) => t.label);
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
})();

/** `accept` attribute value for a file input. */
export const ACCEPTED_MIME_LIST = Object.values(IMAGE_TYPES)
  .map((t) => t.mime)
  .join(',');

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

function startsWithBytes(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;

/** ISO-BMFF brands that mean "this is an AVIF still or sequence". */
const AVIF_BRANDS = new Set(['avif', 'avis']);

/**
 * Identify an image by its leading bytes, or null if it is not one we accept.
 *
 * Deliberately strict. `image/svg+xml` is an image to a browser but a scriptable
 * document to an attacker, and `image/heic` is a container Safari alone renders;
 * both come back null and the upload is refused with a readable reason.
 */
export function sniffImageType(bytes: Uint8Array): ImageKind | null {
  if (bytes.length < 12) return null; // every signature below needs 12 bytes to be sure

  if (startsWithBytes(bytes, PNG_MAGIC)) return 'png';
  if (startsWithBytes(bytes, JPEG_MAGIC)) return 'jpeg';

  const head6 = ascii(bytes, 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';

  // RIFF<u32 size>WEBP — the RIFF prefix alone is also WAV and AVI, so the
  // form type at offset 8 is the part that decides.
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';

  if (ascii(bytes, 4, 8) === 'ftyp') {
    if (AVIF_BRANDS.has(ascii(bytes, 8, 12))) return 'avif';
    // The major brand can be a generic `mif1`/`msf1` with the real brand listed
    // among the compatible brands that fill the rest of the ftyp box.
    const boxSize = readUint32BE(bytes, 0);
    const end = Math.min(bytes.length, boxSize > 16 && boxSize <= 512 ? boxSize : 0);
    for (let i = 16; i + 4 <= end; i += 4) {
      if (AVIF_BRANDS.has(ascii(bytes, i, i + 4))) return 'avif';
    }
  }

  return null;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  return (
    ((bytes[offset]! << 24) >>> 0) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

// ===========================================================================
// Scopes
// ===========================================================================

/**
 * What an upload is for. The scope decides the size cap and — in the route — the
 * permission required, so a line staffer who may edit an activity photo still
 * cannot replace the operator's logo.
 */
export const UPLOAD_SCOPES = {
  branding: {
    maxBytes: 2 * 1024 * 1024,
    label: 'Logo',
    /** Where it ends up: Operator.logo_dark_url / logo_light_url. */
    noun: 'logo',
  },
  activity: {
    maxBytes: 8 * 1024 * 1024,
    label: 'Photo',
    /** Where it ends up: Activity.photo_urls. */
    noun: 'photo',
  },
} as const;

export type UploadScope = keyof typeof UPLOAD_SCOPES;

export const UPLOAD_SCOPE_KEYS = Object.keys(UPLOAD_SCOPES) as UploadScope[];

export function isUploadScope(value: unknown): value is UploadScope {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(UPLOAD_SCOPES, value);
}

/** The widest cap any scope allows — the hard ceiling on what we will buffer. */
export const MAX_UPLOAD_BYTES = Math.max(...UPLOAD_SCOPE_KEYS.map((k) => UPLOAD_SCOPES[k].maxBytes));

/** "2 MB", "6.2 MB", "840 KB" — for error copy a human reads, not a log line. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 bytes';
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? round1(kb) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? round1(mb) : Math.round(mb)} MB`;
}

function round1(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// ===========================================================================
// Validation
// ===========================================================================

export interface UploadRejection {
  code: 'unknown_scope' | 'empty' | 'too_large' | 'unsupported_type';
  /** Shown to the operator verbatim. Says what is wrong AND what to do. */
  message: string;
  status: 400 | 413 | 415;
}

export type UploadValidation =
  | { ok: true; scope: UploadScope; kind: ImageKind; mime: string; ext: string; bytes: number }
  | { ok: false; error: UploadRejection };

export interface ValidateUploadInput {
  scope: string;
  bytes: Uint8Array;
  /** The browser's claim. Recorded for the message only — never trusted. */
  declaredType?: string | null;
}

/**
 * Decide whether these bytes may be stored, under this scope.
 *
 * Pure: no clock, no filesystem, no randomness. Everything the route rejects,
 * it rejects through here, which is what makes the rules unit-testable.
 */
export function validateImageUpload(input: ValidateUploadInput): UploadValidation {
  const { scope } = input;
  if (!isUploadScope(scope)) {
    return {
      ok: false,
      error: {
        code: 'unknown_scope',
        status: 400,
        message: `Unknown upload scope "${scope}". Expected one of: ${UPLOAD_SCOPE_KEYS.join(', ')}.`,
      },
    };
  }

  const spec = UPLOAD_SCOPES[scope];
  const size = input.bytes.byteLength;

  if (size === 0) {
    return {
      ok: false,
      error: { code: 'empty', status: 400, message: 'That file is empty. Pick another image.' },
    };
  }

  if (size > spec.maxBytes) {
    return {
      ok: false,
      error: {
        code: 'too_large',
        status: 413,
        message: `That image is ${formatBytes(size)}. A ${spec.noun} has to be under ${formatBytes(spec.maxBytes)} — try exporting it smaller.`,
      },
    };
  }

  const kind = sniffImageType(input.bytes);
  if (!kind) {
    // Quote what the browser claimed, because "it says PNG right there" is the
    // first thing the operator will think when a renamed file is refused.
    const claimed = (input.declaredType ?? '').trim();
    const claimSuffix = claimed ? ` The browser called it "${claimed}", but the file's own contents say otherwise.` : '';
    return {
      ok: false,
      error: {
        code: 'unsupported_type',
        status: 415,
        message: `That file is not a ${ACCEPTED_IMAGE_LABEL} image.${claimSuffix}`,
      },
    };
  }

  const type = IMAGE_TYPES[kind];
  return { ok: true, scope, kind, mime: type.mime, ext: type.ext, bytes: size };
}

// ===========================================================================
// Keys and names
// ===========================================================================

/** 16 random bytes as hex, plus the extension we chose. Never client-derived. */
export function generateStoredName(ext: string): string {
  if (!Object.prototype.hasOwnProperty.call(CONTENT_TYPE_BY_EXT, ext)) {
    throw new StorageError(`Refusing to store an unknown extension "${ext}"`, 'bad_extension', 500);
  }
  return `${randomBytes(16).toString('hex')}.${ext}`;
}

const STORED_NAME_RE = new RegExp(`^[0-9a-f]{32}\\.(?:${Object.keys(CONTENT_TYPE_BY_EXT).join('|')})$`);

/**
 * Would we have written this name? Only names this function accepts are ever
 * turned into a path, so `..`, a separator, a null byte, a second extension or
 * anything else a client invents is rejected before `join` sees it.
 */
export function isSafeStoredName(name: string): boolean {
  return STORED_NAME_RE.test(name);
}

const OPERATOR_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Operator ids are cuids (or the seed's `lsra`); nothing else is a directory. */
export function isSafeOperatorId(id: string): boolean {
  return OPERATOR_ID_RE.test(id);
}

/** The extension of a stored name, assuming `isSafeStoredName` already passed. */
export function extensionOf(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

export interface ObjectKeyParts {
  operatorId: string;
  scope: UploadScope;
  name: string;
}

/** `<operator>/<scope>/<name>` — the same key in the local tree and in R2. */
export function buildObjectKey(parts: ObjectKeyParts): string {
  if (!isSafeOperatorId(parts.operatorId)) {
    throw new StorageError('Invalid operator id for a storage key', 'invalid_key', 400);
  }
  if (!isUploadScope(parts.scope) || !isSafeStoredName(parts.name)) {
    throw new StorageError('Invalid storage key', 'invalid_key', 400);
  }
  return `${parts.operatorId}/${parts.scope}/${parts.name}`;
}

/**
 * The inverse, and the gate every read goes through. Returns null — never a
 * partially-trusted object — for anything that is not a key we ourselves wrote.
 */
export function parseObjectKey(key: string): ObjectKeyParts | null {
  if (typeof key !== 'string' || key.length > 200 || key.includes('\0')) return null;
  const segments = key.split('/');
  if (segments.length !== 3) return null;
  const [operatorId, scope, name] = segments as [string, string, string];
  if (!isSafeOperatorId(operatorId)) return null;
  if (!isUploadScope(scope)) return null;
  if (!isSafeStoredName(name)) return null;
  return { operatorId, scope, name };
}

/**
 * Resolve a key to an absolute path under `root`.
 *
 * Two independent defences, because one is a bug away from none: the key must
 * first parse (so it cannot contain a separator or a dot segment at all), and
 * the resolved path is then asserted to sit under the resolved root. Pure —
 * takes the root rather than reading it — so the containment property is
 * testable without touching a disk.
 */
export function objectPathIn(root: string, key: string): string {
  const parts = parseObjectKey(key);
  if (!parts) throw new StorageError('Invalid storage key', 'invalid_key', 400);
  const base = resolve(root);
  const path = resolve(join(base, parts.operatorId, parts.scope, parts.name));
  if (path !== base && !path.startsWith(base + sep)) {
    throw new StorageError('Storage key escaped the upload root', 'invalid_key', 400);
  }
  return path;
}

// ===========================================================================
// The interface
// ===========================================================================

export interface PutObjectInput {
  key: string;
  body: Uint8Array;
  contentType: string;
}

export interface StoredObject {
  key: string;
  /** Absolute, public, and what we persist into `logo_dark_url` & friends. */
  url: string;
  contentType: string;
  bytes: number;
}

export interface StorageDriver {
  readonly name: 'local' | 'r2';
  put(input: PutObjectInput): Promise<StoredObject>;
  /** True if an object was removed, false if it was already gone. */
  remove(key: string): Promise<boolean>;
  urlFor(key: string): string;
}

/**
 * Pick the driver. One rule, shared with every other provider: `SANDBOX=local`
 * (or simply not being in production) means the disk; `SANDBOX=cloud` means R2.
 */
export function storageDriver(): StorageDriver {
  return sandboxEnabled() ? localStorageDriver : r2StorageDriver;
}

// ===========================================================================
// Local driver
// ===========================================================================

let cachedRoot: string | null = null;

/**
 * Where the local tree lives: `SANDBOX_UPLOAD_DIR` if set, else
 * `<repo root>/.sandbox/uploads`.
 *
 * The repo root is found by walking up for `pnpm-workspace.yaml` rather than
 * assuming a cwd, because the API is started both from the repo root
 * (`pnpm dev:local`) and from `apps/api` (`pnpm --filter`), and the uploads must
 * land in the same place either way — a logo that vanishes because you started
 * the server from a different directory is not a faithful simulation of R2.
 */
export function uploadRoot(): string {
  const override = process.env.SANDBOX_UPLOAD_DIR?.trim();
  if (override) return resolve(override);
  if (cachedRoot) return cachedRoot;
  cachedRoot = join(repoRoot(), '.sandbox', 'uploads');
  return cachedRoot;
}

function repoRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd());
}

/**
 * The base the local URLs are built from. `PUBLIC_UPLOAD_BASE_URL` wins so a
 * tunnel or a LAN address can be used when testing on a phone; otherwise the
 * API's own origin.
 */
export function localBaseUrl(): string {
  const explicit =
    process.env.PUBLIC_UPLOAD_BASE_URL ??
    process.env.API_BASE_URL ??
    process.env.NEXT_PUBLIC_API_BASE_URL;
  if (explicit?.trim()) return explicit.trim().replace(/\/+$/, '');
  return `http://localhost:${process.env.PORT ?? 3001}`;
}

export const localStorageDriver: StorageDriver = {
  name: 'local',

  async put({ key, body, contentType }) {
    const path = objectPathIn(uploadRoot(), key);
    await mkdir(dirname(path), { recursive: true });
    // Write-then-rename: a crash mid-write must not leave a truncated file at a
    // URL we already handed back. `wx` also guarantees we never clobber.
    const tmp = `${path}.${randomBytes(6).toString('hex')}.part`;
    try {
      await writeFile(tmp, body, { flag: 'wx' });
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw new StorageError(
        `Could not write the upload to disk: ${err instanceof Error ? err.message : String(err)}`,
        'write_failed',
        500,
      );
    }
    return { key, url: this.urlFor(key), contentType, bytes: body.byteLength };
  },

  async remove(key) {
    const path = objectPathIn(uploadRoot(), key);
    try {
      await rm(path);
      return true;
    } catch (err) {
      if (isEnoent(err)) return false;
      throw new StorageError(
        `Could not delete the upload: ${err instanceof Error ? err.message : String(err)}`,
        'delete_failed',
        500,
      );
    }
  },

  urlFor(key) {
    return `${localBaseUrl()}/uploads/${key}`;
  },
};

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

export interface LoadedObject {
  bytes: Buffer;
  contentType: string;
  size: number;
  /** Last write time, for `Last-Modified`. */
  modified: Date;
}

/**
 * Read one local object for the serve route. Returns null when it does not
 * exist; throws StorageError only for a malformed key, which is a 400 rather
 * than a 404 because it means the caller invented the URL.
 */
export async function readLocalObject(key: string): Promise<LoadedObject | null> {
  const parts = parseObjectKey(key);
  if (!parts) throw new StorageError('Invalid storage key', 'invalid_key', 400);
  const path = objectPathIn(uploadRoot(), key);
  try {
    const info = await stat(path);
    if (!info.isFile()) return null; // never follow a directory or a device node
    return {
      bytes: await readFile(path),
      contentType: CONTENT_TYPE_BY_EXT[extensionOf(parts.name)]!,
      size: info.size,
      modified: info.mtime,
    };
  } catch (err) {
    if (isEnoent(err)) return null;
    throw new StorageError(
      `Could not read the upload: ${err instanceof Error ? err.message : String(err)}`,
      'read_failed',
      500,
    );
  }
}

// ===========================================================================
// Cloud twin — Cloudflare R2 over the S3 API
// ===========================================================================

/**
 * The cutover table entry (docs/LOCAL-FIRST-BUILD.md §10) for storage:
 *
 *   SANDBOX=cloud                  select this driver instead of the disk
 *   R2_ACCOUNT_ID                  Cloudflare account id (the R2 endpoint host)
 *   R2_BUCKET                      bucket name
 *   R2_ACCESS_KEY_ID               R2 API token, access key half
 *   R2_SECRET_ACCESS_KEY           R2 API token, secret half
 *   R2_PUBLIC_BASE_URL             the bucket's public hostname, e.g.
 *                                  https://assets.example.com — this is what a
 *                                  stored logo URL is prefixed with, so it must
 *                                  be a domain you keep.
 *
 * Nothing else changes: the keys, the sniffing, the caps and the URLs the app
 * persists all have the same shape in both drivers.
 */
interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
}

function r2Config(): R2Config {
  const cfg = {
    accountId: process.env.R2_ACCOUNT_ID?.trim() ?? '',
    bucket: process.env.R2_BUCKET?.trim() ?? '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() ?? '',
    publicBaseUrl: (process.env.R2_PUBLIC_BASE_URL?.trim() ?? '').replace(/\/+$/, ''),
  };
  const missing = Object.entries(cfg)
    .filter(([, v]) => !v)
    .map(([k]) => `R2_${k.replace(/[A-Z]/g, (ch) => `_${ch}`).toUpperCase()}`);
  if (missing.length) {
    throw new StorageError(
      `Storage is in cloud mode but ${missing.join(', ')} is not set.`,
      'storage_not_configured',
      500,
    );
  }
  return cfg;
}

const R2_REGION = 'auto'; // R2 has no regions; SigV4 still requires the literal
const S3_SERVICE = 's3';

/** AWS's URI encoding: unreserved characters stay, everything else is %XX. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

export interface SigV4Input {
  method: string;
  host: string;
  /** Path segments, unencoded. The signer encodes each one. */
  pathSegments: readonly string[];
  /** Headers to sign besides host/x-amz-date/x-amz-content-sha256. */
  headers?: Record<string, string>;
  /** Hex sha256 of the request body ('' body included). */
  payloadSha256: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
  region?: string;
  service?: string;
}

export interface SigV4Result {
  /** Every header the request must carry, Authorization included. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/**
 * Sign a request AWS SigV4 style, which is what R2's S3 endpoint speaks.
 *
 * Hand-rolled on purpose: pulling in `@aws-sdk/client-s3` for two verbs would
 * add a large dependency to satisfy a code path the owner's laptop never runs.
 * Pure and exported so the canonicalisation is unit-tested without a bucket.
 */
export function signRequestV4(input: SigV4Input): SigV4Result {
  const region = input.region ?? R2_REGION;
  const service = input.service ?? S3_SERVICE;
  const amzDate = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    host: input.host,
    'x-amz-content-sha256': input.payloadSha256,
    'x-amz-date': amzDate,
  };

  const normalized = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = normalized.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = normalized.map(([k]) => k).join(';');

  const canonicalUri = `/${input.pathSegments.map(uriEncode).join('/')}`;
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    '', // no query string on either verb we issue
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}

export const r2StorageDriver: StorageDriver = {
  name: 'r2',

  async put({ key, body, contentType }) {
    const parts = parseObjectKey(key);
    if (!parts) throw new StorageError('Invalid storage key', 'invalid_key', 400);
    const cfg = r2Config();
    const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
    const signed = signRequestV4({
      method: 'PUT',
      host,
      pathSegments: [cfg.bucket, parts.operatorId, parts.scope, parts.name],
      headers: {
        'content-type': contentType,
        // A year, immutable: the name is random, so the bytes at a URL never change.
        'cache-control': 'public, max-age=31536000, immutable',
      },
      payloadSha256: sha256Hex(body),
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      now: new Date(),
    });

    const res = await fetch(`https://${host}/${cfg.bucket}/${key}`, {
      method: 'PUT',
      headers: signed.headers,
      body,
    });
    if (!res.ok) {
      throw new StorageError(
        `R2 rejected the upload (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`,
        'upload_failed',
        502,
      );
    }
    return { key, url: this.urlFor(key), contentType, bytes: body.byteLength };
  },

  async remove(key) {
    const parts = parseObjectKey(key);
    if (!parts) throw new StorageError('Invalid storage key', 'invalid_key', 400);
    const cfg = r2Config();
    const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
    const emptyHash = sha256Hex('');
    const signed = signRequestV4({
      method: 'DELETE',
      host,
      pathSegments: [cfg.bucket, parts.operatorId, parts.scope, parts.name],
      payloadSha256: emptyHash,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      now: new Date(),
    });

    const res = await fetch(`https://${host}/${cfg.bucket}/${key}`, {
      method: 'DELETE',
      headers: signed.headers,
    });
    // S3 semantics: DELETE of a missing key is a 204, so "was it there?" is not
    // knowable without a HEAD. Report it as removed rather than lie about a 404.
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new StorageError(
        `R2 rejected the delete (${res.status})`,
        'delete_failed',
        502,
      );
    }
    return true;
  },

  urlFor(key) {
    return `${r2Config().publicBaseUrl}/${key}`;
  },
};

// ===========================================================================
// Facade used by the route
// ===========================================================================

export interface StoreImageInput {
  operatorId: string;
  scope: UploadScope;
  bytes: Uint8Array;
  kind: ImageKind;
}

/** Store validated bytes and hand back the URL to persist. */
export async function storeImage(input: StoreImageInput): Promise<StoredObject & { driver: string }> {
  const type = IMAGE_TYPES[input.kind];
  const key = buildObjectKey({
    operatorId: input.operatorId,
    scope: input.scope,
    name: generateStoredName(type.ext),
  });
  const driver = storageDriver();
  const stored = await driver.put({ key, body: input.bytes, contentType: type.mime });
  return { ...stored, driver: driver.name };
}

/**
 * Delete one object, refusing anything outside the calling tenant's prefix.
 *
 * Storage sits outside Postgres, so RLS cannot help here — the tenant check is
 * this comparison, and it is why the operator id is a path segment rather than
 * an opaque part of the random name.
 */
export async function deleteImage(operatorId: string, key: string): Promise<boolean> {
  const parts = parseObjectKey(key);
  if (!parts) throw new StorageError('Invalid storage key', 'invalid_key', 400);
  if (parts.operatorId !== operatorId) {
    // Deliberately the same message a missing object gets, so the response
    // cannot be used to probe whether another operator's asset exists.
    throw new StorageError('Upload not found', 'not_found', 404);
  }
  return storageDriver().remove(key);
}
