import { describe, expect, it } from 'vitest';
import { EC_BLOCKS_M, encodeQr, formatInfoBits, qrSvg, qrToSvg, type QrMatrix } from './qr.js';

/**
 * The encoder was verified module-for-module against an independent reference
 * implementation (python-qrcode) for every supported version (1–10) when it was
 * written. These tests lock that behaviour in: an independent decoder in this
 * file reads the symbol back the way a scanner does — format info, unmasking,
 * zigzag extraction, block de-interleaving, Reed–Solomon syndrome check, and
 * byte-mode parsing — so any regression in any stage breaks the round trip.
 */

// ---------------------------------------------------------------------------
// Test-side decoder (independent read path)
// ---------------------------------------------------------------------------

/** GF(2^8) tables mirroring the spec, built independently of the encoder's. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const mul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;

/** Function-module map rebuilt from the spec's layout rules. */
function functionMap(size: number, version: number): boolean[][] {
  const fn = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const mark = (r: number, c: number): void => {
    if (r >= 0 && r < size && c >= 0 && c < size) fn[r]![c] = true;
  };
  // Finders + separators + format areas: 9×9 at the top-left; 9 rows × 8 cols
  // at the top-right (format bits live in row 8); 8 rows × 9 cols at the
  // bottom-left (format bits + dark module live in column 8).
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      mark(r, c);
      if (c < 8) mark(r, size - 1 - c);
      if (r < 8) mark(size - 1 - r, c);
    }
  }
  // Timing.
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  // Alignment patterns (all centre pairs except the three finder corners).
  const table: number[][] = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
    [6, 26, 46], [6, 28, 50],
  ];
  const centers = table[version - 1]!;
  const last = centers.length - 1;
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) mark(centers[i]! + r, centers[j]! + c);
      }
    }
  }
  // Version info blocks (v7+).
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      mark(b, a);
      mark(a, b);
    }
  }
  return fn;
}

const maskAt = (mask: number, r: number, c: number): boolean => {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
};

interface DecodeResult {
  text: string;
  mask: number;
  ecLevelBits: number;
  /** Max Reed–Solomon syndrome magnitude across blocks (0 = clean symbol). */
  syndromeMax: number;
}

/** Read a finished symbol back the way a scanner would. */
function decodeQr(matrix: QrMatrix): DecodeResult {
  const { size, version, modules } = matrix;

  // Format info, second copy (top-right row + bottom-left column).
  let raw = 0;
  for (let i = 0; i <= 7; i++) if (modules[8]![size - 1 - i]) raw |= 1 << i;
  for (let i = 8; i <= 14; i++) if (modules[size - 15 + i]![8]) raw |= 1 << i;
  const fmt = raw ^ 0x5412;
  const mask = (fmt >>> 10) & 0b111;
  const ecLevelBits = (fmt >>> 13) & 0b11;

  // Zigzag extraction with unmasking.
  const fn = functionMap(size, version);
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const row = upward ? size - 1 - vert : vert;
      for (const col of [right, right - 1]) {
        if (fn[row]![col]) continue;
        const dark = modules[row]![col]! !== maskAt(mask, row, col);
        bits.push(dark ? 1 : 0);
      }
    }
    upward = !upward;
  }

  const [ecPerBlock, blockSpec] = EC_BLOCKS_M[version - 1]!;
  const blockSizes: number[] = [];
  for (const [dataLen, count] of blockSpec) {
    for (let i = 0; i < count; i++) blockSizes.push(dataLen);
  }
  const totalCodewords = blockSizes.reduce((a, b) => a + b, 0) + ecPerBlock * blockSizes.length;

  const codewords: number[] = [];
  for (let i = 0; i < totalCodewords; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j]!;
    codewords.push(b);
  }

  // De-interleave data + EC codewords back into per-block streams.
  const blocks: number[][] = blockSizes.map(() => []);
  let idx = 0;
  const maxData = Math.max(...blockSizes);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks.length; b++) {
      if (i < blockSizes[b]!) blocks[b]!.push(codewords[idx++]!);
    }
  }
  const ec: number[][] = blockSizes.map(() => []);
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < blocks.length; b++) ec[b]!.push(codewords[idx++]!);
  }

  // Reed–Solomon syndromes: for a clean codeword, R(α^j) = 0 for all j.
  let syndromeMax = 0;
  for (let b = 0; b < blocks.length; b++) {
    const received = [...blocks[b]!, ...ec[b]!];
    for (let j = 0; j < ecPerBlock; j++) {
      let acc = 0;
      for (const cw of received) acc = mul(acc, EXP[j]!) ^ cw;
      syndromeMax = Math.max(syndromeMax, acc);
    }
  }

  // Byte-mode parse of the concatenated data stream.
  const data: number[] = blocks.flat();
  const bitAt = (i: number): number => (data[i >>> 3]! >>> (7 - (i & 7))) & 1;
  let pos = 0;
  const take = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | bitAt(pos++);
    return v;
  };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`expected byte mode, got ${mode.toString(2)}`);
  const count = take(version <= 9 ? 8 : 16);
  const bytes = new Uint8Array(count);
  for (let i = 0; i < count; i++) bytes[i] = take(8);

  return { text: new TextDecoder().decode(bytes), mask, ecLevelBits, syndromeMax };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('encodeQr', () => {
  const cases: Array<[string, string, number]> = [
    ['short (v1)', 'HELLO', 1],
    ['local sign link (v3)', 'http://localhost:3000/waiver/clx0abc123', 3],
    ['production sign link, multi-block (v4)', 'https://book.lakesonoma.com/waiver/cmf8a1b2c3d4e5f6g7h8', 4],
    ['long URL with version info (v7)', `https://book.example-marina.com/waiver/${'a'.repeat(80)}`, 7],
    ['near-capacity, 16-bit length (v10)', `https://x.io/${'z'.repeat(195)}`, 10],
  ];

  it.each(cases)('round-trips %s through an independent decoder', (_label, text, expectedVersion) => {
    const matrix = encodeQr(text);
    expect(matrix.version).toBe(expectedVersion);
    expect(matrix.size).toBe(expectedVersion * 4 + 17);

    const decoded = decodeQr(matrix);
    expect(decoded.text).toBe(text);
    expect(decoded.mask).toBe(matrix.mask);
    expect(decoded.ecLevelBits).toBe(0b00); // EC level M
    expect(decoded.syndromeMax).toBe(0); // Reed–Solomon codewords are consistent
  });

  it('round-trips multi-byte UTF-8', () => {
    const text = 'https://x.io/waiver/día-señor-⚓';
    expect(decodeQr(encodeQr(text)).text).toBe(text);
  });

  it('is deterministic', () => {
    const a = encodeQr('https://x.io/waiver/abc');
    const b = encodeQr('https://x.io/waiver/abc');
    expect(a.modules).toEqual(b.modules);
    expect(a.mask).toBe(b.mask);
  });

  it('draws the three finder patterns and the dark module', () => {
    const m = encodeQr('finder-check');
    const finderAt = (top: number, left: number): void => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const expected =
            r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          expect(m.modules[top + r]![left + c]).toBe(expected);
        }
      }
    };
    finderAt(0, 0);
    finderAt(0, m.size - 7);
    finderAt(m.size - 7, 0);
    expect(m.modules[m.size - 8]![8]).toBe(true); // dark module
  });

  it('alternates the timing patterns', () => {
    const m = encodeQr('timing-check');
    for (let i = 8; i < m.size - 8; i++) {
      expect(m.modules[6]![i]).toBe(i % 2 === 0);
      expect(m.modules[i]![6]).toBe(i % 2 === 0);
    }
  });

  it('rejects payloads beyond version 10-M capacity', () => {
    expect(() => encodeQr('x'.repeat(214))).toThrow(/too long/);
  });
});

describe('formatInfoBits', () => {
  it('matches the spec value for EC level M, mask 0', () => {
    // Published test vector: format string for M/mask-0 is 101010000010010.
    expect(formatInfoBits(0)).toBe(0b101010000010010);
  });
});

describe('qrToSvg / qrSvg', () => {
  it('renders a scalable SVG with a quiet zone', () => {
    const m = encodeQr('svg-check');
    const svg = qrToSvg(m, { margin: 4 });
    const total = m.size + 8;
    expect(svg).toContain(`viewBox="0 0 ${total} ${total}"`);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('<path d="M');
    // Quiet zone: no dark module may start inside the 4-module margin.
    expect(svg).not.toContain('"M0 ');
    expect(svg).toMatch(/^<svg /);
  });

  it('supports a transparent background', () => {
    const svg = qrSvg('bg-check', { light: 'none' });
    expect(svg).not.toContain('<rect');
  });
});
