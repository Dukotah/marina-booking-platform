/**
 * Storage provider — pure unit tests. No database, no filesystem, no network.
 *
 * Everything an upload has to survive before it is allowed onto disk is decided
 * by pure functions in services/storage.ts, and that is what is proved here:
 *
 *   1. MAGIC BYTES decide the type. A renamed `.png`, an SVG, a PDF and an HTML
 *      page are all refused, and a GIF/HTML polyglot is still typed as a GIF —
 *      which is why the serve route pins `nosniff` and a sandbox CSP.
 *   2. THE CAPS are per scope and the message quotes real sizes.
 *   3. THE STORED NAME is ours: 16 random bytes plus an extension taken from the
 *      sniffed type, so no byte of the client's filename can reach a path.
 *   4. KEYS CANNOT ESCAPE. Traversal, separators, null bytes, wrong segment
 *      counts and foreign scopes are rejected by `parseObjectKey`, and
 *      `objectPathIn` additionally asserts containment under the root.
 *   5. THE R2 SIGNER canonicalises the way SigV4 requires — sorted signed
 *      headers, per-segment URI encoding, and a signature that moves when any
 *      input moves.
 */
import { describe, it, expect } from 'vitest';
import {
  ACCEPTED_IMAGE_LABEL,
  CONTENT_TYPE_BY_EXT,
  IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
  StorageError,
  UPLOAD_SCOPES,
  buildObjectKey,
  extensionOf,
  formatBytes,
  generateStoredName,
  isSafeOperatorId,
  isSafeStoredName,
  isUploadScope,
  objectPathIn,
  parseObjectKey,
  signRequestV4,
  sniffImageType,
  validateImageUpload,
} from '../src/services/storage.js';

// ===========================================================================
// Fixtures — the first bytes of each format, then filler so nothing is
// rejected merely for being short.
// ===========================================================================

function withFiller(head: number[], total = 64): Uint8Array {
  const bytes = new Uint8Array(total);
  bytes.set(head.slice(0, total));
  return bytes;
}

function ascii(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}

const PNG = withFiller([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = withFiller([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF')]);
const GIF87 = withFiller(ascii('GIF87a'));
const GIF89 = withFiller(ascii('GIF89a'));
const WEBP = withFiller([...ascii('RIFF'), 0x24, 0x00, 0x00, 0x00, ...ascii('WEBPVP8 ')]);
const AVIF = withFiller([0x00, 0x00, 0x00, 0x20, ...ascii('ftypavif'), ...ascii('avifmif1')]);
/** `mif1` major brand with `avif` listed among the compatible brands. */
const AVIF_COMPAT = withFiller([
  0x00, 0x00, 0x00, 0x1c,
  ...ascii('ftypmif1'),
  0x00, 0x00, 0x00, 0x00, // minor version
  ...ascii('mif1'),
  ...ascii('avif'),
]);

const SVG = withFiller(ascii('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'));
const HTML = withFiller(ascii('<!DOCTYPE html><html><body>hi</body></html>'));
const PDF = withFiller([...ascii('%PDF-1.7'), 0x0a, 0x25, 0x00, 0x00]);
const ZIP = withFiller([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00]);
const HEIC = withFiller([0x00, 0x00, 0x00, 0x20, ...ascii('ftypheic'), ...ascii('heicmif1')]);
/** RIFF, but a WAV — the prefix alone must not be enough. */
const WAV = withFiller([...ascii('RIFF'), 0x24, 0x00, 0x00, 0x00, ...ascii('WAVEfmt ')]);

// ===========================================================================
// Magic-byte sniffing
// ===========================================================================

describe('sniffImageType', () => {
  it('identifies every format we accept', () => {
    expect(sniffImageType(PNG)).toBe('png');
    expect(sniffImageType(JPEG)).toBe('jpeg');
    expect(sniffImageType(GIF87)).toBe('gif');
    expect(sniffImageType(GIF89)).toBe('gif');
    expect(sniffImageType(WEBP)).toBe('webp');
    expect(sniffImageType(AVIF)).toBe('avif');
  });

  it('finds AVIF behind a generic mif1 major brand', () => {
    expect(sniffImageType(AVIF_COMPAT)).toBe('avif');
  });

  it('refuses SVG — an image to a browser, a script host to an attacker', () => {
    expect(sniffImageType(SVG)).toBeNull();
  });

  it('refuses documents and archives', () => {
    expect(sniffImageType(HTML)).toBeNull();
    expect(sniffImageType(PDF)).toBeNull();
    expect(sniffImageType(ZIP)).toBeNull();
  });

  it('refuses HEIC, which most browsers cannot render', () => {
    expect(sniffImageType(HEIC)).toBeNull();
  });

  it('does not accept a RIFF container that is not WebP', () => {
    expect(sniffImageType(WAV)).toBeNull();
  });

  it('refuses anything too short to carry a signature', () => {
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    // A truncated PNG header: the first four bytes match, the rest do not exist.
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]))).toBeNull();
  });

  it('is not fooled by a near-miss signature', () => {
    const almostPng = withFiller([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]);
    expect(sniffImageType(almostPng)).toBeNull();
    const almostGif = withFiller(ascii('GIF88a'));
    expect(sniffImageType(almostGif)).toBeNull();
  });

  it('types a GIF/HTML polyglot as a GIF, which the serve headers then neutralise', () => {
    const polyglot = withFiller([...ascii('GIF89a'), ...ascii('<script>alert(1)</script>')], 128);
    expect(sniffImageType(polyglot)).toBe('gif');
  });

  it('ignores what the extension would have said', () => {
    // A PDF renamed logo.png is still a PDF.
    expect(sniffImageType(PDF)).toBeNull();
  });
});

// ===========================================================================
// Validation
// ===========================================================================

describe('validateImageUpload', () => {
  it('accepts a real PNG under the branding cap', () => {
    const result = validateImageUpload({ scope: 'branding', bytes: PNG });
    expect(result).toMatchObject({ ok: true, kind: 'png', mime: 'image/png', ext: 'png', bytes: PNG.byteLength });
  });

  it('rejects an unknown scope before looking at a single byte', () => {
    const result = validateImageUpload({ scope: 'wallpaper', bytes: PNG });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_scope');
    expect(result.error.status).toBe(400);
    expect(result.error.message).toContain('branding');
  });

  it('rejects an empty body', () => {
    const result = validateImageUpload({ scope: 'branding', bytes: new Uint8Array(0) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('empty');
    expect(result.error.status).toBe(400);
  });

  it('enforces the cap per scope, not globally', () => {
    const size = UPLOAD_SCOPES.branding.maxBytes + 1;
    const big = new Uint8Array(size);
    big.set(PNG.slice(0, 12));

    const branding = validateImageUpload({ scope: 'branding', bytes: big });
    expect(branding.ok).toBe(false);
    if (!branding.ok) {
      expect(branding.error.code).toBe('too_large');
      expect(branding.error.status).toBe(413);
    }

    // The same bytes are fine as an activity photo — a bigger allowance.
    expect(validateImageUpload({ scope: 'activity', bytes: big })).toMatchObject({ ok: true, kind: 'png' });
  });

  it('quotes both the actual size and the limit in the error copy', () => {
    const big = new Uint8Array(3 * 1024 * 1024);
    big.set(PNG.slice(0, 12));
    const result = validateImageUpload({ scope: 'branding', bytes: big });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('3 MB');
    expect(result.error.message).toContain(formatBytes(UPLOAD_SCOPES.branding.maxBytes));
  });

  it('checks the size before the type, so a huge non-image is not sniffed', () => {
    const big = new Uint8Array(UPLOAD_SCOPES.branding.maxBytes + 1);
    big.set(ZIP.slice(0, 12));
    const result = validateImageUpload({ scope: 'branding', bytes: big });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('too_large');
  });

  it('rejects a file the browser swore was a PNG', () => {
    const result = validateImageUpload({ scope: 'branding', bytes: SVG, declaredType: 'image/png' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unsupported_type');
    expect(result.error.status).toBe(415);
    // The message has to explain the contradiction, or it reads as a bug.
    expect(result.error.message).toContain('image/png');
    expect(result.error.message).toContain(ACCEPTED_IMAGE_LABEL);
  });

  it('omits the browser claim when there was none', () => {
    const result = validateImageUpload({ scope: 'branding', bytes: PDF });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toContain('browser called it');
  });

  it('never returns a content type the client chose', () => {
    const result = validateImageUpload({ scope: 'branding', bytes: JPEG, declaredType: 'image/png' });
    expect(result).toMatchObject({ ok: true, mime: 'image/jpeg', ext: 'jpg' });
  });

  it('exposes the widest cap as the hard ceiling for buffering', () => {
    expect(MAX_UPLOAD_BYTES).toBe(
      Math.max(UPLOAD_SCOPES.branding.maxBytes, UPLOAD_SCOPES.activity.maxBytes),
    );
  });
});

describe('isUploadScope', () => {
  it('accepts only the declared scopes', () => {
    expect(isUploadScope('branding')).toBe(true);
    expect(isUploadScope('activity')).toBe(true);
    expect(isUploadScope('Branding')).toBe(false);
    expect(isUploadScope('')).toBe(false);
    expect(isUploadScope('__proto__')).toBe(false);
    expect(isUploadScope('constructor')).toBe(false); // inherited keys are not scopes
    expect(isUploadScope(null)).toBe(false);
    expect(isUploadScope(42)).toBe(false);
  });
});

describe('formatBytes', () => {
  it('reads like a human wrote it', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1024 * 840)).toBe('840 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2 MB');
    expect(formatBytes(6_500_000)).toBe('6.2 MB');
    expect(formatBytes(64 * 1024 * 1024)).toBe('64 MB');
  });

  it('never renders a negative or a NaN size', () => {
    expect(formatBytes(-1)).toBe('0 bytes');
    expect(formatBytes(Number.NaN)).toBe('0 bytes');
  });
});

// ===========================================================================
// Stored filenames
// ===========================================================================

describe('generateStoredName', () => {
  it('is 32 hex characters plus the extension we chose', () => {
    const name = generateStoredName('png');
    expect(name).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(isSafeStoredName(name)).toBe(true);
  });

  it('produces a name for every accepted type, and refuses anything else', () => {
    for (const type of Object.values(IMAGE_TYPES)) {
      expect(isSafeStoredName(generateStoredName(type.ext))).toBe(true);
    }
    expect(() => generateStoredName('svg')).toThrow(StorageError);
    expect(() => generateStoredName('exe')).toThrow(StorageError);
    expect(() => generateStoredName('php')).toThrow(StorageError);
    expect(() => generateStoredName('')).toThrow(StorageError);
  });

  it('does not collide across a realistic number of uploads', () => {
    const names = new Set(Array.from({ length: 2000 }, () => generateStoredName('jpg')));
    expect(names.size).toBe(2000);
  });

  it('carries nothing the client supplied', () => {
    // There is no input but the extension — a filename cannot reach the disk,
    // which is what makes traversal a non-question rather than a check.
    expect(generateStoredName.length).toBe(1);
  });

  it('agrees with the extension -> content-type map', () => {
    const name = generateStoredName('webp');
    expect(CONTENT_TYPE_BY_EXT[extensionOf(name)]).toBe('image/webp');
  });
});

describe('isSafeStoredName', () => {
  const hex = 'a'.repeat(32);

  it('accepts only names of the shape we write', () => {
    expect(isSafeStoredName(`${hex}.png`)).toBe(true);
    expect(isSafeStoredName(`${hex}.jpg`)).toBe(true);
    expect(isSafeStoredName(`${hex}.avif`)).toBe(true);
  });

  it('rejects traversal, separators and null bytes', () => {
    expect(isSafeStoredName('..')).toBe(false);
    expect(isSafeStoredName('../../etc/passwd')).toBe(false);
    expect(isSafeStoredName(`..\\${hex}.png`)).toBe(false);
    expect(isSafeStoredName(`sub/${hex}.png`)).toBe(false);
    expect(isSafeStoredName(`${hex}.png .txt`)).toBe(false);
    expect(isSafeStoredName(`${hex}%2e%2e.png`)).toBe(false);
  });

  it('rejects a second extension, a wrong extension, or the wrong hex', () => {
    expect(isSafeStoredName(`${hex}.png.html`)).toBe(false);
    expect(isSafeStoredName(`${hex}.svg`)).toBe(false);
    expect(isSafeStoredName(`${hex}.PNG`)).toBe(false);
    expect(isSafeStoredName(`${'A'.repeat(32)}.png`)).toBe(false);
    expect(isSafeStoredName(`${'a'.repeat(31)}.png`)).toBe(false);
    expect(isSafeStoredName(`${'a'.repeat(33)}.png`)).toBe(false);
    expect(isSafeStoredName(`${hex}`)).toBe(false);
    expect(isSafeStoredName('')).toBe(false);
  });
});

describe('isSafeOperatorId', () => {
  it('accepts a cuid and the seed operator, and nothing path-shaped', () => {
    expect(isSafeOperatorId('lsra')).toBe(true);
    expect(isSafeOperatorId('clx8k2f9a0000qwerty123456')).toBe(true);
    expect(isSafeOperatorId('..')).toBe(false);
    expect(isSafeOperatorId('a/b')).toBe(false);
    expect(isSafeOperatorId('a\\b')).toBe(false);
    expect(isSafeOperatorId('')).toBe(false);
    expect(isSafeOperatorId('x'.repeat(65))).toBe(false);
    expect(isSafeOperatorId('op id')).toBe(false);
  });
});

// ===========================================================================
// Keys and paths
// ===========================================================================

describe('object keys', () => {
  const name = `${'b'.repeat(32)}.png`;

  it('round-trips', () => {
    const key = buildObjectKey({ operatorId: 'lsra', scope: 'branding', name });
    expect(key).toBe(`lsra/branding/${name}`);
    expect(parseObjectKey(key)).toEqual({ operatorId: 'lsra', scope: 'branding', name });
  });

  it('refuses to build a key from anything it did not vet', () => {
    expect(() => buildObjectKey({ operatorId: '../evil', scope: 'branding', name })).toThrow(StorageError);
    expect(() => buildObjectKey({ operatorId: 'lsra', scope: 'branding', name: '../../secret.png' })).toThrow(
      StorageError,
    );
    expect(() =>
      // A scope that is not one of ours, forced past the type system the way a
      // query parameter would arrive.
      buildObjectKey({ operatorId: 'lsra', scope: 'wallpaper' as 'branding', name }),
    ).toThrow(StorageError);
  });

  it('parses nothing it did not write', () => {
    expect(parseObjectKey('')).toBeNull();
    expect(parseObjectKey(`lsra/branding/${name}/extra`)).toBeNull();
    expect(parseObjectKey(`lsra/${name}`)).toBeNull();
    expect(parseObjectKey(`lsra/../${name}`)).toBeNull();
    expect(parseObjectKey(`../lsra/branding/${name}`)).toBeNull();
    expect(parseObjectKey(`lsra/branding/${name} `)).toBeNull();
    expect(parseObjectKey(`lsra/wallpaper/${name}`)).toBeNull();
    expect(parseObjectKey(`lsra/branding/${'x'.repeat(200)}.png`)).toBeNull();
    expect(parseObjectKey(`/lsra/branding/${name}`)).toBeNull();
    expect(parseObjectKey(42 as unknown as string)).toBeNull();
  });
});

describe('objectPathIn', () => {
  const root = '/srv/app/.sandbox/uploads';
  const name = `${'c'.repeat(32)}.jpg`;

  it('lands inside the root', () => {
    const path = objectPathIn(root, `lsra/branding/${name}`);
    // Compared with separators normalised, so the assertion holds on Windows too.
    expect(path.replace(/\\/g, '/')).toContain('/.sandbox/uploads/lsra/branding/');
    expect(path.endsWith(name)).toBe(true);
  });

  it('throws rather than resolving anything that could escape', () => {
    expect(() => objectPathIn(root, `../../../etc/passwd`)).toThrow(StorageError);
    expect(() => objectPathIn(root, `lsra/branding/..%2f..%2fetc%2fpasswd`)).toThrow(StorageError);
    expect(() => objectPathIn(root, `lsra/branding/${name}/../../../../etc/passwd`)).toThrow(StorageError);
    expect(() => objectPathIn(root, '')).toThrow(StorageError);
  });

  it('reports a 400, not a 500 — an invented URL is a bad request', () => {
    try {
      objectPathIn(root, 'nope');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).status).toBe(400);
      expect((err as StorageError).code).toBe('invalid_key');
    }
  });
});

// ===========================================================================
// R2 request signing
// ===========================================================================

describe('signRequestV4', () => {
  const base = {
    method: 'PUT',
    host: 'acct123.r2.cloudflarestorage.com',
    pathSegments: ['marina-assets', 'lsra', 'branding', `${'d'.repeat(32)}.png`],
    headers: { 'content-type': 'image/png' },
    payloadSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret-example',
    now: new Date('2026-08-26T17:04:05.123Z'),
  };

  it('builds the canonical request SigV4 specifies', () => {
    const signed = signRequestV4(base);
    const lines = signed.canonicalRequest.split('\n');
    expect(lines[0]).toBe('PUT');
    expect(lines[1]).toBe(`/marina-assets/lsra/branding/${'d'.repeat(32)}.png`);
    expect(lines[2]).toBe(''); // no query string
    // Headers are sorted, lower-cased, and each ends in a newline.
    expect(signed.canonicalRequest).toContain('content-type:image/png\n');
    expect(signed.canonicalRequest).toContain('host:acct123.r2.cloudflarestorage.com\n');
    expect(signed.canonicalRequest).toContain('x-amz-date:20260826T170405Z\n');
    expect(signed.canonicalRequest.endsWith(base.payloadSha256)).toBe(true);
  });

  it('signs host, date and payload hash, in sorted order', () => {
    const signed = signRequestV4(base);
    expect(signed.headers.Authorization).toContain(
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date',
    );
    expect(signed.headers['x-amz-content-sha256']).toBe(base.payloadSha256);
    expect(signed.headers['x-amz-date']).toBe('20260826T170405Z');
  });

  it('uses the auto region and the s3 service in the credential scope', () => {
    const signed = signRequestV4(base);
    expect(signed.stringToSign.split('\n')[0]).toBe('AWS4-HMAC-SHA256');
    expect(signed.stringToSign).toContain('20260826/auto/s3/aws4_request');
    expect(signed.headers.Authorization).toContain(
      'Credential=AKIAEXAMPLE/20260826/auto/s3/aws4_request',
    );
  });

  it('is deterministic for identical inputs', () => {
    expect(signRequestV4(base).signature).toBe(signRequestV4(base).signature);
    expect(signRequestV4(base).signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when anything that matters changes', () => {
    const original = signRequestV4(base).signature;
    expect(signRequestV4({ ...base, secretAccessKey: 'other' }).signature).not.toBe(original);
    expect(signRequestV4({ ...base, method: 'DELETE' }).signature).not.toBe(original);
    expect(signRequestV4({ ...base, payloadSha256: 'f'.repeat(64) }).signature).not.toBe(original);
    expect(signRequestV4({ ...base, now: new Date('2026-08-27T17:04:05Z') }).signature).not.toBe(original);
    expect(
      signRequestV4({ ...base, pathSegments: ['marina-assets', 'other', 'branding', 'x.png'] }).signature,
    ).not.toBe(original);
  });

  it('URI-encodes each path segment without encoding the separators', () => {
    const signed = signRequestV4({ ...base, pathSegments: ['my bucket', "o'brien", 'a+b', 'x~y'] });
    const uri = signed.canonicalRequest.split('\n')[1];
    expect(uri).toBe("/my%20bucket/o%27brien/a%2Bb/x~y");
  });

  it('drops the milliseconds AWS does not accept', () => {
    expect(signRequestV4(base).headers['x-amz-date']).not.toContain('.');
  });
});
